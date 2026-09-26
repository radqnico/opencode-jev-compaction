/**
 * Plugin options. Single place where `ctx.options` (unknown) is narrowed.
 * Everything downstream uses `ResolvedPluginOptions` — never raw options.
 */
export interface ResolvedPluginOptions {
  readonly apiKey: string | undefined
  readonly model: string
  /** Custom System One endpoint. Defaults to https://api.typesafe.ai/v1/systemone. */
  readonly baseUrl: string | undefined
  /** Extra HTTP headers merged into every Jev request (e.g. proxy auth). */
  readonly headers: Record<string, string> | undefined
  readonly goal: string | undefined
  readonly keepThreshold: number | undefined
  readonly preserveRecentMessages: number | undefined
  readonly maxStateTokens: number | undefined
  readonly maxRequestTokens: number | undefined
  readonly truncateHeadChars: number | undefined
  readonly minReductionRatio: number
}

export const PLUGIN_DEFAULTS = {
  model: "jev-latest",
  minReductionRatio: 0.25,
} as const

function optionNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionNumberOr(value: unknown, fallback: number): number {
  const n = optionNumber(value)
  return n === undefined ? fallback : n
}

function optionHeaders(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const entries: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) entries[k] = v
  }
  return Object.keys(entries).length > 0 ? entries : undefined
}

/** Narrows `ctx.options` (unknown) into `ResolvedPluginOptions`. Never throws. */
export function parseOptions(raw: unknown): ResolvedPluginOptions {
  const record: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return {
    apiKey: optionString(record["apiKey"]),
    model: optionString(record["model"]) ?? PLUGIN_DEFAULTS.model,
    baseUrl: optionString(record["baseUrl"]),
    headers: optionHeaders(record["headers"]),
    goal: optionString(record["goal"]),
    keepThreshold: optionNumber(record["keepThreshold"]),
    preserveRecentMessages: optionNumber(record["preserveRecentMessages"]),
    maxStateTokens: optionNumber(record["maxStateTokens"]),
    maxRequestTokens: optionNumber(record["maxRequestTokens"]),
    truncateHeadChars: optionNumber(record["truncateHeadChars"]),
    minReductionRatio: optionNumberOr(record["minReductionRatio"], PLUGIN_DEFAULTS.minReductionRatio),
  }
}

/** Resolves the API key: explicit option first, then the environment. */
export function resolveApiKey(options: ResolvedPluginOptions): string | undefined {
  if (options.apiKey) return options.apiKey
  const fromEnv = process.env.TYPESAFE_API_KEY
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined
}
