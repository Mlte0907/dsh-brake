/**
 * dsh-brake 行为回归：直接驱动真实插件入口（lib/index.js），不经 DSH 宿主。
 * 覆盖：重复调用提醒阈值与去重、序列循环、deny 守卫、重复文本（批内/跨消息/冷却/重置）、
 * waterfall 组合（下游 block 保留）、配置校验。
 * 运行：node test/test-brake.js
 */
'use strict'

const assert = require('node:assert/strict')
const plugin = require('../lib/index.js')

/** 最小 cordis替身：捕获监听器与守卫，waterfall 按 next() 委托链串联。 */
function makeCtx() {
  const listeners = new Map()
  const guards = []
  /** 从第 i 个监听器开始执行链条，默认决策由最后一个监听器之后的链尾给出。 */
  function chain(name, tail) {
    const fns = listeners.get(name) ?? []
    const run = i => async () => i < fns.length ? fns[i](...argsOf(i), run(i + 1)) : args[i]
  }
  return {
    guards,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    tools: { guard(fn) { guards.push(fn); return () => {} } },
    async postExecute(exec, result) {
      const fns = listeners.get('tools/post-execute') ?? []
      const call = i => async () => i < fns.length
        ? fns[i](exec, result, call(i + 1))
        : { kind: 'accept' }
      return call(0)()
    },
    preStepListeners: () => listeners.get('agent/pre-step') ?? [],
    async preStep(agent, messages) {
      const fns = listeners.get('agent/pre-step') ?? []
      const payload = { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }
      const call = i => async () => i < fns.length
        ? fns[i](payload, call(i + 1))
        : { kind: 'enter', messages: [] }
      return call(0)()
    },
  }
}

const agent = {}
const exec = (name, args, callId = 'c1') => ({ agent, name, arguments: args, callId })
const textResult = text => ({ isError: false, content: [{ type: 'text', text }] })

/** 提取决策里的 dsh-brake 提醒文本（post-execute 决策与 pre-step 消息两个位置都覆盖）。 */
function noticeTexts(decision) {
  const fromContexts = (decision.additionalContexts ?? [])
    .filter(message => message.source?.plugin === 'dsh-brake')
  const fromMessages = (decision.messages ?? [])
    .filter(message => message.source?.plugin === 'dsh-brake')
  return [...fromContexts, ...fromMessages]
    .flatMap(message => message.content.map(block => block.type === 'text' ? block.text : ''))
}

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`) }
  catch (error) { failed++; console.log(`  ❌ ${name}: ${error.message}`) }
}

async function main() {
  console.log('dsh-brake behavior tests\n')

  await test('identical call ×2 warns once at threshold and still reaches downstream', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { callWarnCount: 2 })
    let downstreamRuns = 0
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      downstreamRuns++
      return next()
    })
    const first = await ctx.postExecute(exec('grep', { pattern: 'x' }), textResult('a'))
    assert.equal(noticeTexts(first).length, 0)
    const second = await ctx.postExecute(exec('grep', { pattern: 'x' }), textResult('a'))
    const texts = noticeTexts(second)
    assert.equal(texts.length, 1)
    assert.match(texts[0], /重复 2 次/)
    assert.match(texts[0], /dsh-brake/)
    assert.equal(downstreamRuns, 2, 'downstream must always run (waterfall semantics)')
  })

  await test('distinct arguments never warn; same call with different args is a different identity', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { callWarnCount: 2 })
    for (let i = 0; i < 5; i++) {
      const decision = await ctx.postExecute(exec('read', { file_path: `f${i}` }), textResult('x'))
      assert.equal(noticeTexts(decision).length, 0, `call ${i} with fresh args must not warn`)
    }
  })

  await test('repeat warnings are throttled, not per-call spam', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { callWarnCount: 2, callReWarnEvery: 5, sequenceCount: 99 })
    const seen = []
    for (let i = 0; i < 10; i++) {
      const decision = await ctx.postExecute(exec('bash', { command: 'x' }), textResult('y'))
      seen.push(...noticeTexts(decision).filter(text => text.includes('重复执行')))
    }
    assert.equal(seen.length, 2, 'warn at 2, then only after 5 more')
    assert.match(seen[0], /重复 2 次/)
    assert.match(seen[1], /重复 7 次/)
  })

  await test('repeating sequence of different tools triggers the sequence notice', async () => {
    const ctx = makeCtx()
    // callReWarnEvery 拉高：每个旋转相位（A→B→C / B→C→A / C→A→B）只提醒一次。
    plugin.apply(ctx, { sequenceLength: 3, sequenceCount: 2, callWarnCount: 99, callDenyCount: 200, callReWarnEvery: 999 })
    const calls = [['grep', { pattern: 'p' }], ['curl', { url: 'u' }], ['read', { file_path: 'f' }]]
    const seen = []
    for (let i = 0; i < 12; i++) {
      const [name, args] = calls[i % 3]
      const decision = await ctx.postExecute(exec(name, args), textResult('r'))
      seen.push(...noticeTexts(decision).filter(text => text.includes('序列循环')))
    }
    assert.equal(seen.length, 3, 'one notice per rotation reaching the threshold')
  })

  await test('deny mode: guard refuses only the confirmed repeated identity, downstream still sees it', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { mode: 'deny', callWarnCount: 2, callDenyCount: 4 })
    assert.equal(ctx.guards.length, 1, 'deny mode registers exactly one guard')
    for (let i = 0; i < 3; i++) {
      await ctx.postExecute(exec('grep', { pattern: 'same' }), textResult('a'))
    }
    assert.equal(ctx.guards[0](exec('grep', { pattern: 'same' })), undefined, 'below deny count: allowed')
    await ctx.postExecute(exec('grep', { pattern: 'same' }), textResult('a'))
    const reason = ctx.guards[0](exec('grep', { pattern: 'same' }))
    assert.match(reason, /已拒绝执行|重复/)
    assert.equal(ctx.guards[0](exec('grep', { pattern: 'other' })), undefined, 'different args stay allowed')
    assert.equal(ctx.guards[0]({ name: 'read', arguments: {} }), undefined, 'no agent: never deny')
  })

  await test('duplicate text inside one message batch counts across messages by fingerprint', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { duplicateTextThreshold: 3, duplicateTextCooldownMs: 0, minimumDuplicateChars: 20 })
    const block = { type: 'text', text: 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor' }
    const message = id => ({ id, role: 'user', content: [block], source: { kind: 'plugin', plugin: 'some-injector' } })
    const agent2 = {}
    const run = messages => ctx.preStep(agent2, messages)
    const first = await run([message('m1')])
    assert.equal(noticeTexts(first).length, 0, 'one message: no duplicate yet')
    const second = await run([message('m2')])
    assert.equal(noticeTexts(second).length, 0, 'second message: count 2 below threshold 3')
    const third = await run([message('m3')])
    const texts = noticeTexts(third)
    assert.equal(texts.length, 1, 'third message reaches the threshold')
    assert.match(texts[0], /重复上下文/)
    assert.match(texts[0], /some-injector/)
    assert.match(texts[0], /3 次/)
    assert.ok(texts[0].includes('lorem'), 'preview quotes the duplicated text')
  })

  await test('same message id is counted once, not once per observation', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { duplicateTextThreshold: 2, duplicateTextCooldownMs: 0, minimumDuplicateChars: 20 })
    const message = { id: 'same-id', role: 'user', content: [{ type: 'text', text: 'repeat me please, this is long enough for detection for sure.' }] }
    const agent3 = {}
    for (let i = 0; i < 4; i++) {
      const decision = await ctx.preStep(agent3, [message])
      assert.equal(noticeTexts(decision).length, 0, 'same id must never re-count')
    }
  })

  await test('reminders merge onto a downstream block decision without dropping feedback', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { callWarnCount: 2 })
    ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'policy denied' }] }))
    await ctx.postExecute(exec('grep', { q: 1 }), textResult('a'))
    const blocked = await ctx.postExecute(exec('grep', { q: 1 }), textResult('a'))
    assert.equal(blocked.kind, 'block')
    assert.equal(noticeTexts(blocked).length, 1)
  })

  await test('human message resets all counters', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { callWarnCount: 2 })
    await ctx.postExecute(exec('grep', { q: 1 }), textResult('a'))
    await ctx.preStep(agent, [{ id: 'u1', role: 'user', content: [], source: { kind: 'user' } }])
    const decision = await ctx.postExecute(exec('grep', { q: 1 }), textResult('a'))
    assert.equal(noticeTexts(decision).length, 0, 'count restarted after human message')
  })

  await test('invalid config fails loud at load', async () => {
    assert.throws(() => plugin.apply(makeCtx(), { callDenyCount: 3, callWarnCount: 5 }), /callDenyCount/)
    assert.throws(() => plugin.apply(makeCtx(), { mode: 'block' }), /mode/)
    assert.throws(() => plugin.apply(makeCtx(), { callWarnCount: 1.5 }), /callWarnCount/)
    assert.throws(() => plugin.apply(makeCtx(), { duplicateTextWindowMs: 10 }), /duplicateTextWindowMs/)
    plugin.apply(makeCtx(), {}) // defaults are valid
  })

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

/** 取出真实插件注册的监听器（测试驱动用）。 */
function listeners(ctx) {
  return ctx._listeners ?? []
}

main().catch(error => { console.error(error); process.exitCode = 1 })
