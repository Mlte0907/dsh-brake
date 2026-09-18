/**
 * dsh-brake — 死循环刹车器
 *
 * 监测两类无进展信号，默认只提醒，不修改历史日志、不删除消息：
 *   1. 调用循环：同一调用（工具名 + 规范化参数）或同一调用序列在窗口内反复出现；
 *   2. 重复文本上下文：不同消息 ID 的相同正文在时间窗口内被反复注入，
 *      或单条消息内同一正文多次出现。
 *
 * 组合规则：tools/post-execute 与 agent/pre-step 都是 waterfall——始终 await next()
 * 并把提醒叠加到下游决策上；提醒经 createUserMessage 生成，带稳定消息 id，
 * 以 { kind: 'plugin', plugin: 'dsh-brake', form: 'notice' } 来源注入。
 * mode: 'deny' 时额外注册 ctx.tools.guard()，仅拒绝已确认重复的同一调用身份；
 * 序列循环保持提醒。人类消息（source.kind === 'user'）重置该 agent 的全部状态。
 */
'use strict'

const { createUserMessage } = require('@deepseek-ai/dsh-llm')

const PLUGIN_NAME = 'dsh-brake'

/** 规范化参数文本上限：超长参数截断后保留长度信息，避免超大 payload 放大内存。 */
const ARGUMENTS_HASH_CAP = 4096
/** 单个 agent 最多跟踪的文本指纹条目数，超出按最近出现时间淘汰。 */
const MAX_TEXT_ENTRIES = 256
/** 单个 agent 最多保留的序列指纹条目数。 */
const MAX_SEQUENCE_ENTRIES = 128
/** 单个 agent 最多记录的已见消息 ID 数（pre-step 批次通常很小）。 */
const MAX_SEEN_MESSAGE_IDS = 512
/** 提醒文本中引用的正文预览上限。 */
const TEXT_PREVIEW_CHARS = 160
/** 调用窗口长度上限。 */
const MAX_WINDOW = 64

/**
 * @typedef {object} Config
 * @property {'remind'|'deny'} [mode] 默认 'remind'；'deny' 额外注册执行前守卫。
 * @property {number} [callWarnCount] 同一调用身份重复达到该次数时提醒（默认 6）。
 * @property {number} [callDenyCount] deny 模式下开始拒绝的重复次数（默认 10，须 > callWarnCount）。
 * @property {number} [sequenceLength] 序列循环检测的序列长度（默认 4）。
 * @property {number} [sequenceCount] 同一序列重复达到该次数时提醒（默认 3）。
 * @property {number} [minWindowCalls] 调用检测需要的最少窗口样本（默认 4）。
 * @property {number} [callReWarnEvery] 同一重复链两次提醒之间至少再累计的次数（默认 5）。
 * @property {number} [duplicateTextThreshold] 时间窗口内相同正文新增达到该次数时提醒（默认 3）。
 * @property {number} [duplicateTextWindowMs] 重复文本的时间窗口毫秒（默认 120000）。
 * @property {number} [duplicateTextCooldownMs] 同一指纹两次提醒之间的最小间隔毫秒（默认 30000）。
 * @property {number} [minimumDuplicateChars] 参与文本检测的最小正文长度（默认 80）。
 */

/** 加载期校验并归一化配置；错误立即抛出，绝不静默回退。 */
function resolveConfig(config = {}) {
  const int = (fallback, name, { min }) => {
    const value = config[name] ?? fallback
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`dsh-brake: ${name} must be an integer >= ${min}, got ${value}`)
    }
    return value
  }
  const resolved = {
    mode: config.mode ?? 'remind',
    callWarnCount: int(6, 'callWarnCount', { min: 2 }),
    callDenyCount: int(10, 'callDenyCount', { min: 2 }),
    sequenceLength: int(4, 'sequenceLength', { min: 2 }),
    sequenceCount: int(3, 'sequenceCount', { min: 2 }),
    callReWarnEvery: int(5, 'callReWarnEvery', { min: 1 }),
    minWindowCalls: int(4, 'minWindowCalls', { min: 2 }),
    duplicateTextThreshold: int(3, 'duplicateTextThreshold', { min: 2 }),
    duplicateTextWindowMs: int(120000, 'duplicateTextWindowMs', { min: 1000 }),
    duplicateTextCooldownMs: int(30000, 'duplicateTextCooldownMs', { min: 0 }),
    minimumDuplicateChars: int(80, 'minimumDuplicateChars', { min: 1 }),
  }
  if (resolved.mode !== 'remind' && resolved.mode !== 'deny') {
    throw new Error(`dsh-brake: mode must be 'remind' or 'deny', got ${String(config.mode)}`)
  }
  if (resolved.callDenyCount <= resolved.callWarnCount) {
    throw new Error(`dsh-brake: callDenyCount (${resolved.callDenyCount}) must be greater than callWarnCount (${resolved.callWarnCount})`)
  }
  return resolved
}

/** FNV-1a 32 位哈希的十六进制串；只用于指纹比较，不做安全用途。 */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 深层按键排序后序列化，使仅属性顺序不同的参数得到同一指纹。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** 一次调用的稳定身份：工具名 + 规范化参数（超长参数截断，保留长度信息）。 */
function callKey(name, args) {
  let canonical
  try {
    canonical = canonicalJson(args ?? null)
  } catch {
    // 循环引用等不可序列化参数：退化为实例标识，不参与跨调用匹配。
    canonical = `<unserializable:${fnv1a(String(args))}>`
  }
  if (canonical.length > ARGUMENTS_HASH_CAP) {
    canonical = `${canonical.slice(0, ARGUMENTS_HASH_CAP)}|len=${canonical.length}`
  }
  return `${name} ${fnv1a(canonical)}`
}

/** 文本指纹：合并换行差异后哈希；只用于检测，不改变原文本。 */
function textKey(text) {
  return fnv1a(text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim())
}

/** 供提醒引用的正文预览。 */
function preview(text) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= TEXT_PREVIEW_CHARS ? compact : `${compact.slice(0, TEXT_PREVIEW_CHARS)}…`
}

/** 内容块中的长文本；用于提取重复段落与预览。 */
function longTexts(content, minimumChars) {
  if (!Array.isArray(content)) return []
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.length >= minimumChars)
    .map(block => block.text)
}

const WARN_COPY =
  '[dsh-brake] 检测到重复执行：同一调用已连续重复 {count} 次（{tool}）。'
  + '如果这是轮询或有意的等待请忽略；否则请检查上一次结果，'
  + '换用不同参数、不同方法，或直接向用户报告结论。'

const SEQUENCE_COPY =
  '[dsh-brake] 检测到调用序列循环：{seq} 这一序列已重复 {count} 次。'
  + '请停止该方向，重新分析问题，或向用户确认。'

const TEXT_COPY =
  '[dsh-brake] 检测到重复上下文：相同正文（{preview}）在 {seconds} 秒内新增 {count} 次'
  + '（来源：{sources}）。请复用已有内容，避免再次注入或检索相同文本。'

/** 生成带插件来源与 notice 摘要的提醒消息（含稳定 id）。 */
function reminder(text, summary) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary },
  })
}

/** 短字符串列表去重拼接，用于提醒中的来源说明。 */
function uniqueJoined(values) {
  return [...new Set(values)].join(', ')
}

/** 每个 agent 的检测状态；挂在 WeakMap 上，随 agent 释放。 */
class AgentState {
  constructor(config) {
    this.config = config
    /** 最近调用：{ key, ts }，定长窗口。 */
    this.calls = []
    /** 调用身份计数：key -> { count, warnedAt } */
    this.callCounts = new Map()
    /** 序列计数：序列 key -> { count, warnedAt } */
    this.sequenceCounts = new Map()
    /** 文本指纹：hash -> { count, firstTs, lastTs, sources, lastWarnTs } */
    this.textEntries = new Map()
    /** 已计入文本检测的消息 ID，防止同一条消息跨步骤重复计数。 */
    this.seenMessageIds = new Set()
  }

  reset() {
    this.calls.length = 0
    this.callCounts.clear()
    this.sequenceCounts.clear()
    this.textEntries.clear()
    this.seenMessageIds.clear()
  }

  /** 记录一次调用并返回其身份 key。 */
  recordCall(name, args, now) {
    const key = callKey(name, args)
    this.calls.push({ key, ts: now })
    if (this.calls.length > Math.max(this.config.minWindowCalls, this.config.sequenceLength)) {
      this.calls.shift()
    }
    return key
  }

  /** 同一调用身份的累计计数（含本次）。 */
  recordCallCount(key) {
    let entry = this.callCounts.get(key)
    if (!entry) {
      entry = { count: 0, warnedAt: 0 }
      this.callCounts.set(key, entry)
    }
    entry.count += 1
    return entry
  }

  /** 最近 sequenceLength 次调用组成的序列 key；样本不足返回 null。 */
  sequenceKey() {
    const { sequenceLength } = this.config
    if (this.calls.length < sequenceLength) return null
    return this.calls.slice(-sequenceLength).map(call => call.key).join(' → ')
  }

  /** 记录一次序列出现并返回其计数；保持映射有界。 */
  recordSequence(seqKey) {
    let entry = this.sequenceCounts.get(seqKey)
    if (!entry) {
      entry = { count: 0, warnedAt: 0 }
      this.sequenceCounts.set(seqKey, entry)
      if (this.sequenceCounts.size > MAX_SEQUENCE_ENTRIES) {
        for (const oldest of this.sequenceCounts.keys()) {
          this.sequenceCounts.delete(oldest)
          break
        }
      }
    }
    entry.count += 1
    return entry
  }

  /** 记录一次文本指纹出现；时间窗口过期时重新起算。 */
  recordText(hash, sourceLabel, now) {
    let entry = this.textEntries.get(hash)
    if (!entry) {
      entry = { count: 0, firstTs: now, lastTs: now, sources: [], lastWarnTs: -Infinity }
      this.textEntries.set(hash, entry)
    }
    entry.lastTs = now
    entry.sources.push(sourceLabel)
    if (entry.sources.length > 8) entry.sources.shift()
    if (now - entry.firstTs > this.config.duplicateTextWindowMs) {
      entry.firstTs = now
      entry.count = 1
    } else {
      entry.count += 1
    }
    this.pruneText()
    return entry
  }

  /** 淘汰长期未出现的指纹，保持内存有界。 */
  pruneText() {
    if (this.textEntries.size <= MAX_TEXT_ENTRIES) return
    const sorted = [...this.textEntries.entries()].sort((a, b) => a[1].lastTs - b[1].lastTs)
    for (const [hash] of sorted.slice(0, this.textEntries.size - MAX_TEXT_ENTRIES)) {
      this.textEntries.delete(hash)
    }
  }

  /** 是否应当为该文本指纹提醒（阈值 + 冷却）。 */
  shouldWarnText(entry, now) {
    if (entry.count < this.config.duplicateTextThreshold) return false
    if (entry.lastWarnTs >= 0 && now - entry.lastWarnTs < this.config.duplicateTextCooldownMs) return false
    return true
  }
}

/**
 * 安装刹车器监听器。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文，监听器随其释放。
 * @param {Config} config - 见 README；非法值在加载时抛出。
 */
function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const states = new WeakMap()

  function stateFor(agent) {
    let state = states.get(agent)
    if (!state) {
      state = new AgentState(cfg)
      states.set(agent, state)
    }
    return state
  }

  function duplicateTextNotice(state, content, sourceLabel, now) {
    const notices = []
    const warnedHashes = new Set()
    for (const text of longTexts(content, cfg.minimumDuplicateChars)) {
      // 守卫拒绝文本会作为被拒结果流回 post-execute；排除自身输出，防止自反馈计数。
      if (/^Error: dsh-brake:/.test(text)) continue
      const hash = textKey(text)
      const entry = state.recordText(hash, sourceLabel, now)
      if (warnedHashes.has(hash) || !state.shouldWarnText(entry, now)) continue
      warnedHashes.add(hash)
      entry.lastWarnTs = now
      notices.push(reminder(
        TEXT_COPY
          .replace('{preview}', preview(text))
          .replace('{seconds}', String(Math.round(cfg.duplicateTextWindowMs / 1000)))
          .replace('{count}', String(entry.count))
          .replace('{sources}', uniqueJoined(entry.sources)),
        `duplicate text × ${entry.count}`,
      ))
    }
    return notices
  }

  // ── 调用循环：执行后观测（被拒调用也经过 post-execute，一样计数） ──
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!exec.agent) return downstream

    const state = stateFor(exec.agent)
    const now = Date.now()
    const key = state.recordCall(exec.name, exec.arguments, now)
    const notices = []

    const callEntry = state.recordCallCount(key)
    const firstWarn = callEntry.warnedAt === 0 && callEntry.count >= cfg.callWarnCount
    const reWarn = callEntry.warnedAt > 0
      && callEntry.count >= callEntry.warnedAt + cfg.callReWarnEvery
    if (firstWarn || reWarn) {
      callEntry.warnedAt = callEntry.count
      notices.push(reminder(
        WARN_COPY.replace('{count}', String(callEntry.count)).replace('{tool}', exec.name),
        `${exec.name} × ${callEntry.count}`,
      ))
    }

    const seqKey = state.sequenceKey()
    if (seqKey) {
      const seqEntry = state.recordSequence(seqKey)
      const seqFirst = seqEntry.warnedAt === 0 && seqEntry.count >= cfg.sequenceCount
      const seqRe = seqEntry.warnedAt > 0
        && seqEntry.count >= seqEntry.warnedAt + cfg.callReWarnEvery
      if (seqFirst || seqRe) {
        seqEntry.warnedAt = seqEntry.count
        notices.push(reminder(
          SEQUENCE_COPY
            .replace('{seq}', preview(seqKey))
            .replace('{count}', String(seqEntry.count)),
          'sequence loop × ' + seqEntry.count,
        ))
      }
    }

    notices.push(...duplicateTextNotice(state, result?.content, exec.name, now))

    if (notices.length === 0) return downstream
    return { ...downstream, additionalContexts: [...notices, ...downstream.additionalContexts ?? []] }
  })

  // ── 执行前守卫：仅 deny 模式，且只拒绝已确认重复的同一调用身份 ──
  if (cfg.mode === 'deny') {
    ctx.tools.guard(exec => {
      if (!exec.agent) return undefined
      const state = states.get(exec.agent)
      if (!state) return undefined
      const entry = state.callCounts.get(callKey(exec.name, exec.arguments))
      if (!entry || entry.count < cfg.callDenyCount) return undefined
      return `dsh-brake: 同一调用（${exec.name}，相同参数）已重复 ${entry.count} 次仍未取得进展，已拒绝执行。请改变方法或向用户报告。`
    })
  }

  // ── 输入侧：识别新注入消息中的重复文本；人类消息重置该 agent 状态 ──
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (messages.some(message => message.source?.kind === 'user')) {
      const state = states.get(agent)
      if (state) state.reset()
      return next()
    }
    const state = stateFor(agent)
    const now = Date.now()
    const notices = []
    for (const message of messages) {
      if (state.seenMessageIds.has(message.id)) continue
      state.seenMessageIds.add(message.id)
      if (state.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
        for (const oldest of state.seenMessageIds) {
          state.seenMessageIds.delete(oldest)
          break
        }
      }
      const sourceLabel = message.source?.kind === 'plugin' && typeof message.source.plugin === 'string'
        ? message.source.plugin
        : (message.source?.kind ?? 'user')
      notices.push(...duplicateTextNotice(state, message.content, sourceLabel, now))
    }
    const decision = await next()
    if (decision.kind !== 'enter' || notices.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...notices] }
  })
}

/** 声明注入：deny 模式的守卫需要读取工具注册表（ctx.tools.guard）。 */
const inject = ['tools']

module.exports = { apply, name: 'dsh-brake', inject }
