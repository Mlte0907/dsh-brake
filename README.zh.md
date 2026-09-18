# dsh-brake

English | [中文](README.md)

## Summary

dsh-brake 是一个 DSH 插件，防止 agent 会话空转：它观察已执行的工具调用与新注入的上下文，在同样的工作反复出现且没有进展时提醒模型。它检测重复的相同调用、重复的调用序列和重复的文本块，并以插件来源的通知附加到下一次模型请求。默认只提醒；可选的 `deny` 模式增加单调守卫，在执行前拒绝已确认的重复调用。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

```bash
cd ~/.dsh/profiles/web   # 或你的 profile 目录
pnpm add /path/to/dsh-brake
```

然后在 profile 的 `package.json` 中，把 `"dsh-brake"` 加入 `dsh.profile.bundles` 数组。

### What you get

- **重复调用提醒。** 相同工具名 + 相同规范化参数，跨执行累计计数。首次提醒在 `callWarnCount`（默认 6），之后每多重复 `callReWarnEvery` 次（默认 5）才再次提醒——绝不逐调用刷屏。
- **序列循环提醒。** `sequenceLength` 次不同调用组成的窗口（默认 4，最小 2）重复出现——例如 `grep → curl → read → bash` 循环——在 `sequenceCount` 次重复（默认 3）时提醒。序列身份包含参数，换查询就是新序列。
- **重复上下文提醒。** 同一文本块（换行规范化后指纹，最少 `minimumDuplicateChars` 字符）在 `duplicateTextWindowMs` 内被不同消息 ID 反复注入，或单条消息内多次出现。按消息 ID 计数，历史重放不会累计；同一指纹受 `duplicateTextCooldownMs` 节流。提醒会列出观察到的来源。
- **可选拒绝。** `mode: 'deny'` 时，`ctx.tools.guard` 在 `callDenyCount` 次重复后拒绝该确切调用身份。其余一切保持提醒。人类消息重置该 agent 的全部计数。

### Configuration

```yaml
- id: dsh-brake
  config:
    mode: remind                 # remind | deny
    callWarnCount: 6             # 首次调用提醒的重复次数
    callDenyCount: 10            # deny 模式阈值；必须 > callWarnCount
    callReWarnEvery: 5           # 同一重复链两次提醒之间至少再累计的次数
    sequenceLength: 4            # 序列长度（最小 2）
    sequenceCount: 3             # 序列提醒的重复次数
    duplicateTextThreshold: 3    # 窗口内提醒的注入次数
    duplicateTextWindowMs: 120000
    duplicateTextCooldownMs: 30000
    minimumDuplicateChars: 80
```

非法值在插件加载时抛出；绝不静默回退。

### Tests

```bash
node test/test-brake.js
```

直接驱动真实插件入口（`lib/index.js`），覆盖两条 waterfall 与守卫契约：阈值、节流、按参数身份、deny 范围、重复文本计数（含消息 ID 去重与冷却）、人类消息重置、下游保留和配置快速失败。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply()` 注册两条 waterfall 监听器，deny 模式下再加一条守卫。`tools/post-execute` 总是先调用 `next()`，再把提醒叠加到下游决策的 `additionalContexts`；被拒绝的调用也经过同一 waterfall，所以模型反复重试被拒调用同样计数。`agent/pre-step` 只检查本步骤领取的消息（按消息 ID 去重），把提醒追加到 `enter` 决策的 `messages`，并在出现人类消息（`source.kind === 'user'`）时重置全部状态。提醒是 `createUserMessage()` 生成的消息，带 `{ kind: 'plugin', plugin: 'dsh-brake', form: 'notice' }` 来源，因此有稳定 id 并以插件通知呈现，不会被当作用户提示。每 agent 状态存放在以 agent 为键的 `WeakMap`；守卫只拒绝 post-execute 计数达到 `callDenyCount` 的调用身份，绝不拒绝无 agent 的调用。指纹使用 FNV-1a：参数用按键排序的规范化 JSON，文本用换行规范化；文本条目有界并按最近出现时间淘汰。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- 仓库内的 `repeat-tool-reminder` 覆盖连续相同工具+参数链的递进提醒；dsh-brake 补充序列循环、重复上下文与可选拒绝。两者可同时启用。

-----

<a id="model-experience"></a>
## Model Experience

通知是带插件来源的 `user` 角色消息，进入下一次请求的历史，并像其他注入上下文一样持久化在会话日志中。每条通知都很简短，只陈述观察到的事实（工具、次数、序列或重复文本预览），不回贴完整重复内容。检测只读取执行与收件箱消息；从不改写工具结果，也不删除已记录的内容。

## Known Limitations and Deferred Work

- 未实现近似重复检测（轻微措辞改动）；只有空白/换行规范化后的精确指纹会计数。
- 拒绝只覆盖确切的调用身份；序列循环不会被拒绝。
- 不监测流式输出；助手文本只能在提交后观察。
- 插件假定 DSH 的 `tools/post-execute`、`agent/pre-step` 与 `ctx.tools.guard` 契约；未在其他 Cordis 宿主上验证。

<a id="dev-note"></a>
### Dev Note

测试是零依赖的 Node 脚本，要求 `@deepseek-ai/dsh-llm` 可从插件目录解析——在 DSH profile 环境成立。真实循环组合覆盖（agent-loop + Loader）暂缓；见上方限制。
