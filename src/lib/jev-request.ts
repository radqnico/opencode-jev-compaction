/**
 * Jev wire request/response helpers, ported from
 * `tamaratran/fast-jev-compaction` (`src/request.ts`, MIT).
 *
 * Pure functions. No Effect, no I/O. See `LICENSE-THIRD-PARTY.md`.
 */
import type { JevAnswer, JevQuestions, JevResponse, JevState } from "./jev-types.js"

export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone"
export const DEFAULT_MODEL = "jev-latest"

export interface JevRequest {
  readonly url: string
  readonly method: "POST"
  readonly headers: Record<string, string>
  readonly body: string
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    readonly apiKey: string
    readonly model?: string
    readonly baseUrl?: string
    /** Extra headers. `authorization` and `content-type` always win. */
    readonly headers?: Record<string, string>
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: "POST",
    headers: {
      ...params.headers,
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  }
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Jev returned malformed JSON")
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("answers" in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== "object"
  ) {
    throw new Error("Jev response is missing answers")
  }
  return parsed as JevResponse
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name]
  if (
    !answer ||
    !("noul" in answer) ||
    typeof answer.noul !== "number" ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`)
  }
  return answer.noul
}
