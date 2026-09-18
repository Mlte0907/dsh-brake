/**
 * dsh-brake 宿主接入测试：真实 cordis Context + 真实 ToolRuntime 注册表。
 * 覆盖：inject 声明、tools.guard 经由真实注册表的执行前拒绝、身份隔离、
 * deny 结果文本。与 test-brake.js 互补（那是替身 waterfall 的行为回归）。
 * 运行：node test/test-host.js
 */
'use strict'

const assert = require('node:assert/strict')
const { Context } = require('@deepseek-ai/cordis')
const SystemPrompt = require('@deepseek-ai/dsh-system-prompt').default ?? require('@deepseek-ai/dsh-system-prompt')
const ToolRuntime = require('@deepseek-ai/dsh-tools').default ?? require('@deepseek-ai/dsh-tools')
const { defineContentToolFixture } = require('@deepseek-ai/dsh-tools')
const plugin = require('../lib/index.js')

/** 注册探针工具并返回注册表引用；在注入了 tools 的插件作用域内访问（仓库测试同款路径）。 */
function makeProbeHost(ctx) {
  const observed = { calls: 0 }
  const host = {
    name: 'probe-host',
    inject: ['tools'],
    apply(scope) {
      const tools = scope.tools
      tools.register(defineContentToolFixture({
        name: 'probe',
        description: 'probe tool for host smoke',
        parameters: { q: { type: 'number' } },
        async execute() {
          observed.calls += 1
          return [{ type: 'text', text: `ok ${observed.calls}` }]
        },
      }))
      observed.tools = tools
    },
  }
  return { host, observed }
}

async function main() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ name: 'dsh-brake', apply: plugin.apply, inject: ['tools'] }, {
    mode: 'deny',
    callWarnCount: 2,
    callDenyCount: 3,
    duplicateTextThreshold: 2,
    duplicateTextCooldownMs: 0,
    minimumDuplicateChars: 10,
  })
  const { host, observed } = makeProbeHost(ctx)
  await ctx.plugin(host)

  const agent = {}
  const call = (id, args) => observed.tools.execute({
    signal: new AbortController().signal, callId: id, name: 'probe', arguments: args, agent,
  })

  // 三次相同调用（低于 deny 阈值 3 时执行；第 4 次起守卫拒绝，正文不再运行）。
  for (let i = 0; i < 3; i++) {
    const result = await call(`c${i}`, { q: 1 })
    assert.equal(result.isError, false, `call ${i} below deny threshold must execute`)
  }
  const denied = await call('c4', { q: 1 })
  assert.equal(denied.isError, true, 'deny mode refuses the confirmed repeated call')
  assert.match(denied.content[0].text, /dsh-brake/)
  const different = await call('c5', { q: 2 })
  assert.equal(different.isError, false, 'different identity stays allowed')
  assert.equal(observed.calls, 4, 'the 4th identical call was refused before its body ran')

  console.log('host smoke: ctx.get(tools) + deny-through-registry + identity isolation OK')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
