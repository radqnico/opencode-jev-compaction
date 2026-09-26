/**
 * Shared Jev / SystemOne wire types, ported from
 * `tamaratran/fast-jev-compaction` (`src/types.ts`, MIT).
 *
 * Original copyright (c) 2025, tamaratran. See `LICENSE-THIRD-PARTY.md`.
 */

export type Role = "user" | "assistant"

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (the host attaches them).
 */
export interface ToolUse {
  readonly tool_use_id: string
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly text?: string
  readonly isError?: boolean
}

/** A tool_result block of a user message. */
export interface ToolResult {
  readonly tool_use_id: string
  readonly text: string
  readonly isError?: boolean
}

/**
 * One transcript message. The shape is a subset of the host session message,
 * so a session transcript can be adapted into it without loss.
 */
export interface Message {
  readonly role: Role
  readonly text: string
  readonly toolUses: readonly ToolUse[]
  readonly toolResults?: readonly ToolResult[]
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  readonly id: string
  readonly tool_use_id: string
  readonly tool: string
  readonly input: Record<string, unknown>
  /** Index of the message holding the tool_use block. */
  readonly callIndex: number
  /** Index of the message holding the tool_result block. */
  readonly resultIndex: number
  readonly resultChars: number
  readonly isError: boolean
  /** In the first or the newest preserved messages; never a candidate. */
  readonly pinned: boolean
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  readonly keepCall: number
  /** Jev's probability that the full result still needs to stay verbatim. */
  readonly keepResult: number
}

export type CallAction = "keep" | "drop_result" | "drop_call"

export interface CallDecision extends CallAnswer {
  readonly id: string
  readonly tool: string
  readonly action: CallAction
  readonly reason: "pinned" | "kept" | "result_dropped" | "call_dropped"
}

export interface HistoryToolCall {
  readonly id: string
  readonly tool: string
  readonly input: string
  readonly result: string
}

export interface HistoryEntry {
  readonly i: number
  readonly role: Role
  readonly text: string
  /** Structured per call, or one compact line per call once the state has to shrink. */
  readonly tool_calls?: readonly HistoryToolCall[] | readonly string[]
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  readonly context: string
  readonly goal: string
  readonly history: readonly HistoryEntry[]
}

export interface FittedState {
  readonly state: CompactionState
  readonly tokens: number
  /** Which fitting stage produced the state, for diagnostics. */
  readonly stage: string
}

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  readonly goal?: string
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  readonly keepThreshold?: number
  /** Newest messages never touched (the first message is always kept). Default 6. */
  readonly preserveRecentMessages?: number
  /** Estimated token ceiling for the state. Default 25000. */
  readonly maxStateTokens?: number
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  readonly maxRequestTokens?: number
  /** Characters of a dropped tool result to retain. Default 300. */
  readonly truncateHeadChars?: number
}

export interface ResolvedCompactOptions {
  readonly goal: string
  readonly keepThreshold: number
  readonly preserveRecentMessages: number
  readonly maxStateTokens: number
  readonly maxRequestTokens: number
  readonly truncateHeadChars: number
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  readonly messages: readonly Message[]
  readonly decisions: readonly CallDecision[]
  readonly stats: {
    readonly messagesBefore: number
    readonly messagesAfter: number
    readonly charsBefore: number
    readonly charsAfter: number
    readonly calls: number
    readonly kept: number
    readonly resultsDropped: number
    readonly callsDropped: number
    readonly pinned: number
    readonly stateTokens: number
    /** Which fitting stage the state needed, '' when no request was made. */
    readonly stateStage: string
    readonly requests: number
    readonly ms: number
  }
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object

export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: {
    readonly true?: string
    readonly false?: string
  }
}

export interface ChoiceQuestion {
  readonly type: "choice"
  readonly instructions: string
  readonly criteria: Record<string, string | null>
}

export interface ScoreQuestion {
  readonly type: "score"
  readonly instructions: string
  readonly criteria: readonly string[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
export type JevQuestions = Record<string, JevQuestion>

export interface NoulAnswer {
  readonly type?: "noul"
  readonly noul: number
}

export interface ChoiceAnswer {
  readonly type?: "choice"
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Record<string, number>
}

export interface ScoreAnswer {
  readonly type?: "score"
  readonly score: number
  readonly confidence: number
  readonly probabilities: Record<string, number>
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface JevResponse {
  readonly model?: string
  readonly answers: Record<string, JevAnswer>
  readonly usage?: {
    readonly input_tokens?: number
    readonly output_tokens?: number
  }
  readonly [key: string]: unknown
}

/** Anything that can answer Jev questions. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>
}
