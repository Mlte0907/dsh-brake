/**
 * dsh-brake 真实 agent-loop 行为测试：
 * 走完完整链路 — mock adapter → 模型请求 → 工具调用 → dsh-brake 提醒注入 → session log。
 * 不依赖真实 API（DEEPSEEK_API_KEY），通过脚本化 mock adapter 模拟工具调用响应。
 * 运行：node test/test-e2e.js
 */
'use strict'

const assert = require('node:assert/strict')
const { Context } = require('@deepseek-ai/cordis')
const { ToolCallId, LlmAdapter, ToolCallId: ToolCallIdBrand } = require('@deepseek-ai/dsh-llm')
const { mountAgentLoopTestDependencies } = require('/home/xiaoxin/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js')
const AgentLoop = require('@deepseek-ai/dsh-agent-loop').default ?? require('@deepseek-ai/dsh-agent-loop')
const { SessionId } = require('@deepseek-ai/dsh-session')
const { defineContentToolFixture } = require('@deepseek-ai/dsh-tools')
const plugin = require('../lib/index.js')

/** 最小脚本化 mock adapter：每轮模型请求消费一条 script entry，返回 StreamChunk。 */
class MockAdapter extends LlmAdapter {
  constructor(script) {
    super()
    this.script = [...script]
    this.requests = []
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }
  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('MockAdapter: script exhausted')
    if (typeof entry === 'function') {
      for (const chunk of entry(options)) yield chunk
    } else {
      for (const chunk of entry) yield chunk
    }
  }
}

/** 流式文本响应。 */
function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, c => ({ type: 'text-delta', index: 0, text: c })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 流式工具调用响应。 */
function toolCallResponse(callId, name, args) {
  const argsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** 等待 agent 进入 idle。 */
function waitForIdle(ctx, agent) {
  return new Promise(resolve => {
    const d = ctx.on('agent/status', ({ agent: s, status }) => {
      if (s === agent && status === 'idle') { d(); resolve() }
    })
  })
}

/** 从 session log 中提取所有 dsh-brake 提醒。 */
function brakeNotices(agent) {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'user/message' && e.data.source?.plugin === 'dsh-brake')
    .map(e => ({
      text: e.data.content.map(b => b.type === 'text' ? b.text : '').join('|'),
      source: e.data.source,
    }))
}

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`) }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`) }
}

async function harness(config = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(plugin, config)
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'probe tool', parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  return ctx
}

async function main() {
  console.log('dsh-brake e2e behavior tests\n')

  await test('repeated identical tool calls trigger a dsh-brake notice in session log', async () => {
    const ctx = await harness({ callWarnCount: 3, duplicateTextThreshold: 999, minimumDuplicateChars: 9999 })
    // 脚本：先请求工具调用 5 次（同参数），然后模型回复最终文本。
    const script = []
    for (let i = 0; i < 5; i++) script.push(toolCallResponse(`c${i}`, 'probe', {}))
    script.push(textResponse('done'))
    ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
    const agent = await ctx.agentLoop.create(SessionId('e1'), { provider: 'mock', model: 'mock' })
    agent.followup(require('@deepseek-ai/dsh-llm').createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    const notices = brakeNotices(agent)
    assert.ok(notices.length >= 1, `expected >= 1 dsh-brake notice, got ${notices.length}`)
    assert.ok(notices.some(n => n.text.includes('重复执行')), `notice should mention '重复执行', got: ${notices[0]?.text}`)
    console.log(`    found ${notices.length} dsh-brake notice(s), first: ${notices[0].text.slice(0, 80)}...`)
  })

  await test('different arguments do not trigger repeated-call notice', async () => {
    const ctx = await harness({ callWarnCount: 3, duplicateTextThreshold: 999, minimumDuplicateChars: 9999 })
    // 脚本：5 次工具调用，每次不同参数。
    const script = []
    for (let i = 0; i < 5; i++) script.push(toolCallResponse(`c${i}`, 'probe', { i }))
    script.push(textResponse('done'))
    ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
    const agent = await ctx.agentLoop.create(SessionId('e2'), { provider: 'mock', model: 'mock' })
    agent.followup(require('@deepseek-ai/dsh-llm').createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    const notices = brakeNotices(agent)
    const repeatNotices = notices.filter(n => n.text.includes('重复执行'))
    assert.equal(repeatNotices.length, 0, `different args should not trigger, got ${repeatNotices.length} repeat notices`)
  })

  await test('human message resets the dsh-brake counter', async () => {
    const ctx = await harness({ callWarnCount: 3, duplicateTextThreshold: 999, minimumDuplicateChars: 9999 })
    // 一次性脚本：2 次工具调用 + 回复 + 人类消息重置后 2 次相同调用 + 回复（共 4 次 probe，但中间有重置，不会累计到 3）。
    const script = [
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('first batch done'),
      // 这里模型会停，agent-loop 等待下一条人类消息
      // 人类消息后，模型再请求 2 次工具调用
      toolCallResponse('c3', 'probe', {}),
      toolCallResponse('c4', 'probe', {}),
      textResponse('second batch done'),
    ]
    ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
    const agent = await ctx.agentLoop.create(SessionId('e3'), { provider: 'mock', model: 'mock' })
    agent.followup(require('@deepseek-ai/dsh-llm').createUserMessage({
      content: [{ type: 'text', text: 'start' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    // 人类消息重置计数器。
    agent.followup(require('@deepseek-ai/dsh-llm').createUserMessage({
      content: [{ type: 'text', text: 'reset now' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    const notices = brakeNotices(agent)
    const repeatNotices = notices.filter(n => n.text.includes('重复执行'))
    assert.equal(repeatNotices.length, 0, 'after human reset, counter should restart; got repeat notices')
  })

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })
