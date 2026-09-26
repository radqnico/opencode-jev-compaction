/**
 * Thin adapter: OpenCode `compaction` hook event → Jev pruning → `event.result`.
 *
 * One abstraction level: adapt (pure) → compact (effect) → decide → act.
 * No scoring strings, no Jev wording here — those live in `src/lib/`.
 *
 * Fallback semantics (ported from upstream `hooks/fast-jev.ts`):
 * missing API key, Jev failure, unfittable history, or reduction below
 * `minReductionRatio` → leave `event.result` unset so OpenCode runs its
 * built-in model summary.
 */
import { Effect } from "effect"
import type { Scope } from "effect/Scope"
import type { Message } from "@opencode/ai"
import type { Plugin } from "@opencode/plugin/effect"
import { compact, reductionRatio } from "../lib/jev-compact.js"
import type { CompactResult } from "../lib/jev-types.js"
import { JevClient, toEffectAsker } from "../jev/client.js"
import type { ResolvedPluginOptions } from "../options.js"
import { resolveApiKey } from "../options.js"
import { toLibraryMessages } from "./adapter.js"
import { renderSummary } from "./render.js"

export interface JevCompactionOutcome {
  readonly status: "jev"
  readonly reason: string
  readonly result: CompactResult
}

export interface FallbackOutcome {
  readonly status: "fallback"
  readonly reason: string
}

export type CompactionOutcome = JevCompactionOutcome | FallbackOutcome

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function describeOutcome(outcome: CompactionOutcome, messageCount: number): string {
  if (outcome.status === "fallback") return `fallback to built-in summary (${outcome.reason})`
  const result = outcome.result
  return (
    `kept ${result.stats.messagesAfter}/${messageCount} messages, no summary ` +
    `(${percent(reductionRatio(result))} reduction; ${result.stats.resultsDropped} results truncated, ` +
    `${result.stats.callsDropped} calls dropped, ${result.stats.kept} kept, ${result.stats.pinned} pinned; ` +
    `state ~${result.stats.stateTokens} tokens (${result.stats.stateStage}) in ${result.stats.requests} request(s))`
  )
}

function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== "pinned")
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(" ")
}

/** Runs Jev pruning over the hook transcript. Never throws — returns a fallback outcome. */
export function runJevCompaction(
  messages: readonly Message[],
  options: ResolvedPluginOptions,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<CompactionOutcome> {
  const apiKey = resolveApiKey(options)
  if (!apiKey) {
    return Effect.succeed<FallbackOutcome>({
      status: "fallback",
      reason: "TYPESAFE_API_KEY is not configured",
    })
  }
  return Effect.gen(function* () {
    const libraryMessages = toLibraryMessages(messages)
    const asker = toEffectAsker(
      new JevClient({ apiKey, model: options.model, baseUrl: options.baseUrl, headers: options.headers, fetch: fetchImpl }),
    )
    const outcome = yield* Effect.tryPromise({
      try: () =>
        compact(
          libraryMessages,
          {
            ask: (state, questions) =>
              Effect.runPromise(asker.askEffect(state, questions)).catch((cause) => {
                throw cause instanceof Error ? cause : new Error(String(cause))
              }),
          },
          {
            ...(options.goal !== undefined ? { goal: options.goal } : {}),
            ...(options.keepThreshold !== undefined ? { keepThreshold: options.keepThreshold } : {}),
            ...(options.preserveRecentMessages !== undefined
              ? { preserveRecentMessages: options.preserveRecentMessages }
              : {}),
            ...(options.maxStateTokens !== undefined ? { maxStateTokens: options.maxStateTokens } : {}),
            ...(options.maxRequestTokens !== undefined
              ? { maxRequestTokens: options.maxRequestTokens }
              : {}),
            ...(options.truncateHeadChars !== undefined
              ? { truncateHeadChars: options.truncateHeadChars }
              : {}),
          },
        ).then(
          (result): CompactionOutcome =>
            reductionRatio(result) < options.minReductionRatio
              ? {
                  status: "fallback",
                  reason: `below ${percent(options.minReductionRatio)} minimum reduction`,
                }
              : { status: "jev", reason: "pruned", result },
          (cause): CompactionOutcome => ({
            status: "fallback",
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.catch(() =>
        Effect.succeed<CompactionOutcome>({
          status: "fallback",
          reason: "unexpected jev failure",
        }),
      ),
    )
    return outcome
  })
}

/** Registers the `compaction` hook. Callback returns an Effect (never throws — fallback is a value). */
export function registerCompactionHook(
  ctx: Plugin.Context,
  options: ResolvedPluginOptions,
): Effect.Effect<{ readonly dispose: Effect.Effect<void> }, never, Scope> {
  return ctx.session.hook("compaction", (event) =>
    Effect.gen(function* () {
      const outcome = yield* runJevCompaction(event.messages, options)
      yield* Effect.logInfo(`opencode-jev-compaction: ${describeOutcome(outcome, event.messages.length)}`)
      if (outcome.status === "jev") {
        const line = decisionLog(outcome.result)
        if (line.length > 0) yield* Effect.logInfo(`opencode-jev-compaction decisions: ${line}`)
        event.result = { summary: renderSummary(outcome.result) }
      }
      // fallback: leave event.result unset → built-in model summary runs
    }),
  )
}
