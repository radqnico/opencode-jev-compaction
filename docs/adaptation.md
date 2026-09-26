# Adaptation: Claude Code `session.compact` → OpenCode `compaction` hook

Source project: [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
(a Claude Code plugin). This document records where the port is verbatim and
where OpenCode's API forced a different shape.

## What is identical

- **Decision algorithm**: two `noul` questions per tool call (`call_<id>` /
  `result_<id>`), `keepThreshold` → keep / truncate-result / drop-call,
  first message + newest N pinned, texts never removed. (`src/lib/`)
- **State fitting**: same stages, same token estimator, same batching with
  full-state resend. (`src/lib/jev-state.ts`, `src/lib/jev-compact.ts`)
- **Fallback policy**: missing key, Jev failure, unfittable history, or
  reduction below `minReductionRatio` (default 0.25) → fall back to the
  host's built-in summary. (`src/compaction/hook.ts`)
- **API key**: explicit option first, then `TYPESAFE_API_KEY` from the
  environment. Never committed.

## What differs and why

### 1. The hook contract: message list vs summary string

Upstream `hooks/fast-jev.ts` handles `session.compact` and returns
`{ messages }` — the pruned transcript *replaces* the session history and no
summary is produced.

OpenCode's `compaction` hook (`SessionCompaction` in
`@opencode/plugin/dist/effect/session.d.ts`) exposes `event.messages`
(read-only transcript being summarized) plus an optional `event.result`:

```ts
interface SessionCompactionResult {
  summary: string
  providerState?: SessionMessage.ProviderState
  metadata?: Record<string, unknown>
  tokens?: TokenUsage.Info
}
interface SessionCompaction extends SessionContext {
  /** Set to use this compaction and skip the model request. */
  result?: SessionCompactionResult
}
```

There is **no way to return a message list**. Setting `event.result`
skips the model call and stores the compaction; leaving it unset runs the
built-in model summary (our fallback path).

**Consequence (option A from the plan):** the Jev decisions are encoded as
text. `src/compaction/render.ts` renders everything kept verbatim (user /
assistant text in order, kept tool calls with input, kept results verbatim,
truncated results as head + note) behind a header with the Jev stats, plus
the per-call decision list. The pruned transcript is therefore preserved
*inside* the compaction summary instead of replacing history.

This keeps the upstream guarantee that matters — *nothing kept is
rewritten* — but the compaction artifact is a large summary string rather
than a slimmed message list. Later compactions treat it as prior summary
text, not as structured tool history.

### 2. Message shapes

Upstream `Message` is a subset of Claude Code's `SessionMessage`
(`{ role, text, toolUses, toolResults }` with `tool_use_id` pairing).

OpenCode's `Message` (`@opencode/ai`, `dist/schema/messages.d.ts`) is
`{ id?, role: "system" | "user" | "assistant" | "tool", content: ContentPart[] }`
where `ContentPart` is a tagged union (`text` | `media` | `tool-call` |
`tool-result` | `reasoning` | `compaction` | `effort`). Tool calls and
results pair by shared `id` within/across messages.

`src/compaction/adapter.ts` maps: `text` parts concatenated verbatim
(`media`/`reasoning`/`compaction`/`effort` skipped); `tool-call` →
`{ tool_use_id: id, tool: namespace/name, input }`; `tool-result` →
`{ tool_use_id: id, text, isError }` with `json`/`text`/`error`/`content`
values rendered to text. Roles collapse to `user`/`assistant`
(`system`→`user`, `tool`→`assistant`). Index alignment is 1:1 with empty
placeholders so `callIndex`/`resultIndex` stay valid.

### 3. No `turn.complete` auto-compact hook

Upstream registers `turn.complete` to request compaction at
`compactAtPercent` (default 60%). OpenCode auto-compacts natively
(`compaction.auto`, `keep.tokens`, `buffer`), so this hook is dropped.
`compactAtPercent` is not a plugin option.

### 4. Effect, not bare promises

Upstream is promise-based (`JevClient.ask`, `compact()`). The port keeps
`compact()` promise-based (verbatim algorithm, directly unit-testable)
and wraps transport in Effect at the seam: `toEffectAsker` lifts
`JevAsker` into a `JevError`-channel Effect, and the hook callback is an
`Effect.gen` that never throws — fallback is a value, not a catch.

### 5. Tool-result value rendering is new

Upstream tool results are already strings. OpenCode results are typed
values, so `toolResultText` renders them: `json` → `JSON.stringify`,
`text`/`error` → verbatim (error flagged), `content` → text items joined,
file items → `[file: name/uri]`. Behavior for string outputs is identical.
