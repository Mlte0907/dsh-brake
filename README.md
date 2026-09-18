# dsh-brake

English | [中文](README.zh.md)

## Summary

dsh-brake is a DSH plugin that keeps agent sessions from spinning: it watches executed tool calls and newly injected context, and warns the model when the same work repeats without progress. It detects repeated identical calls, repeating call sequences, and duplicated text blocks, then attaches a plugin-sourced notice to the next model request. By default it only advises; an opt-in `deny` mode adds a monotonic guard that refuses a confirmed repeated call before it runs.

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
cd ~/.dsh/profiles/web   # or your profile directory
pnpm add /path/to/dsh-brake
```

Then add `"dsh-brake"` to the `dsh.profile.bundles` array in the profile's `package.json`.

### What you get

- **Repeated-call notices.** The same tool name with the same normalized arguments, counted across executions. First notice at `callWarnCount` (default 6), re-notice only after `callReWarnEvery` further repeats (default 5) — never one notice per call.
- **Sequence-loop notices.** A repeating window of `sequenceLength` distinct calls (default 4, minimum 2) — e.g. `grep → curl → read → bash` cycling — noticed at `sequenceCount` repetitions (default 3). Sequence identity includes arguments, so varying the query is a different sequence.
- **Duplicate-context notices.** The same text block (fingerprinted after newline normalization, minimum `minimumDuplicateChars` chars) injected repeatedly within `duplicateTextWindowMs` across different message ids, or repeated inside one message. Counted per message id, so replayed history never accumulates; throttled by `duplicateTextCooldownMs` per fingerprint. The notice names the sources observed.
- **Opt-in denial.** With `mode: 'deny'`, a `ctx.tools.guard` refuses the exact repeated call identity after `callDenyCount` repeats. Everything else stays advisory. Human messages reset all counters for that agent.

### Configuration

```yaml
- id: dsh-brake
  config:
    mode: remind                 # remind | deny
    callWarnCount: 6             # repeats before the first call warning
    callDenyCount: 10            # deny-mode threshold; must be > callWarnCount
    callReWarnEvery: 5           # repeats between re-warnings on one chain
    sequenceLength: 4            # calls per sequence (min 2)
    sequenceCount: 3             # sequence repetitions before a warning
    duplicateTextThreshold: 3    # injections within the window before a warning
    duplicateTextWindowMs: 120000
    duplicateTextCooldownMs: 30000
    minimumDuplicateChars: 80
```

Invalid values throw at plugin load; nothing falls back silently.

### Tests

```bash
node test/test-brake.js
```

Drives the real plugin entry (`lib/index.js`) through the two waterfalls and the guard contract: thresholds, throttling, per-argument identity, deny scope, duplicate-text counting with id dedupe and cooldown, human-message reset, downstream preservation, and fail-loud config.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply()` registers two waterfall listeners and, in deny mode, one guard. `tools/post-execute` always calls `next()` first, then folds notices onto the downstream decision's `additionalContexts`; denied calls flow through the same waterfall, so a model hammering a denied call still counts. `agent/pre-step` checks only messages claimed for this step (deduplicated by message id), appends notices to an `enter` decision's `messages`, and resets all state when a human message (`source.kind === 'user'`) is present. Notices are `createUserMessage()` values with `{ kind: 'plugin', plugin: 'dsh-brake', form: 'notice' }` sources, so they carry stable ids and render as plugin notices rather than user prompts. Per-agent state lives in a `WeakMap` keyed by the agent; the guard denies only call identities whose post-execute count reached `callDenyCount`, and never denies calls without an agent. Fingerprints use FNV-1a over key-sorted canonical JSON (arguments) or newline-normalized text; text entries are bounded and pruned by recency.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- `repeat-tool-reminder` (in-repo) covers consecutive identical tool+argument chains with escalating detail; dsh-brake adds sequence loops, duplicate context, and optional denial. Both can run together.

-----

<a id="model-experience"></a>
## Model Experience

Notices are `user`-role plugin-source messages that enter the next request's history and persist in the session log like any other injected context. Each notice is short and names the observed fact (tool, count, sequence, or duplicated text preview) without replying the full duplicated payload. Detection reads executions and inbox messages only; it never rewrites tool results or removes logged content.

## Known Limitations and Deferred Work

- Near-duplicate detection (minor wording edits) is not implemented; only exact fingerprints after whitespace/newline normalization count.
- Denial covers exact call identities only; sequence loops are never denied.
- Live streaming output is not monitored; assistant text is only observable after it is committed.
- The plugin assumes the DSH `tools/post-execute`, `agent/pre-step`, and `ctx.tools.guard` contracts; it has not been exercised against other Cordis hosts.

<a id="dev-note"></a>
### Dev Note

Tests are plain Node scripts (no dependencies) and require `@deepseek-ai/dsh-llm` to be resolvable from the plugin directory — true in a DSH profile checkout. Real-loop composition coverage (agent-loop + Loader) is deferred; see the limitation above.
