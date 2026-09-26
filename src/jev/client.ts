/**
 * Effect wrapper + HTTP client for Jev.
 *
 * Thin adapter: the pure algorithm lives in `src/lib/jev-compact.ts`,
 * transport lives here. `fetch` is injected (production: global fetch,
 * tests: fake) — never constructed inside.
 */
import { Effect } from "effect"
import { buildJevRequest, parseJevResponse } from "../lib/jev-request.js"
import type { JevAsker, JevQuestions, JevResponse, JevState } from "../lib/jev-types.js"

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. Resolved lazily per call so tests can set env late. */
  readonly apiKey?: string
  /** Defaults to `jev-latest`. */
  readonly model?: string
  /** Defaults to the System One endpoint. */
  readonly baseUrl?: string
  /** Extra headers merged into every request. `authorization` / `content-type` cannot be overridden. */
  readonly headers?: Record<string, string>
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
}

function resolveApiKey(explicit?: string): string {
  return explicit ?? process.env.TYPESAFE_API_KEY ?? ""
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string | undefined
  private readonly model: string | undefined
  private readonly baseUrl: string | undefined
  private readonly extraHeaders: Record<string, string> | undefined
  private readonly fetcher: typeof fetch

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.baseUrl = options.baseUrl
    this.extraHeaders = options.headers
    this.fetcher = options.fetch ?? fetch
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const apiKey = resolveApiKey(this.apiKey)
    if (!apiKey) throw new Error("TYPESAFE_API_KEY is not configured")
    const request = buildJevRequest(
      { apiKey, model: this.model, baseUrl: this.baseUrl, headers: this.extraHeaders },
      state,
      questions,
    )
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    })
    return parseJevResponse(response.status, response.ok, await response.text())
  }
}

export class JevError {
  readonly _tag = "JevError" as const
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

/** `JevAsker` whose `ask` runs as an Effect with a typed `JevError` channel. */
export interface EffectJevAsker {
  askEffect(state: JevState, questions: JevQuestions): Effect.Effect<JevResponse, JevError>
}

/** Lifts a Promise-based `JevAsker` into an `EffectJevAsker`. */
export function toEffectAsker(asker: JevAsker): EffectJevAsker {
  return {
    askEffect: (state, questions) =>
      Effect.tryPromise({
        try: () => asker.ask(state, questions),
        catch: (cause) =>
          new JevError(cause instanceof Error ? cause.message : String(cause)),
      }),
  }
}

/** Builds the production asker from options (key from options or env). */
export function makeAsker(options: JevClientOptions = {}): EffectJevAsker {
  return toEffectAsker(new JevClient(options))
}
