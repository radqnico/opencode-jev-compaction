/**
 * Adapter: OpenCode `Message` (AI SDK shapes) → library `Message`.
 *
 * The library's `collectToolCalls` pairs tool calls with results by
 * `tool_use_id`. In OpenCode's `Message`, calls and results live in the same
 * `content` array as `tool-call` / `tool-result` parts sharing one `id`,
 * so pairing is structural — no cross-message lookup needed.
 *
 * Text extraction is verbatim: every `text` part concatenated, `media` /
 * `reasoning` / `compaction` / `effort` parts skipped. Tool-result text is
 * extracted from `json` / `text` / `error` / `content` result values.
 */
import type { ContentPart, Message, ToolResultPart } from "@opencode/ai"
import type { Message as LibraryMessage } from "../lib/jev-types.js"

function toolResultText(result: ToolResultPart["result"]): { text: string; isError: boolean } {
  switch (result.type) {
    case "json":
      return { text: safeStringify(result.value), isError: false }
    case "text":
      return { text: toDisplayText(result.value), isError: false }
    case "error":
      return { text: toDisplayText(result.value), isError: true }
    case "content": {
      const text = result.value
        .map((item) =>
          item.type === "text" ? item.text : `[file: ${item.name ?? item.uri}]`,
        )
        .join("\n")
      return { text, isError: false }
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function toDisplayText(value: unknown): string {
  return typeof value === "string" ? value : safeStringify(value)
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return { value: input }
}

function textOfPart(part: ContentPart): string | undefined {
  return part.type === "text" ? part.text : undefined
}

/**
 * Converts one OpenCode message into zero or more library messages.
 *
 * One OpenCode message can hold several tool calls for different tools;
 * the library models one `toolUses` list per message, so a single pass
 * preserves grouping. Returns `undefined` for messages with no text and
 * no tool parts (e.g. pure reasoning) — they carry nothing Jev can judge.
 */
export function toLibraryMessage(message: Message): LibraryMessage | undefined {
  const role = message.role === "assistant" || message.role === "tool" ? "assistant" : message.role === "system" ? "user" : message.role
  const texts: string[] = []
  const toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown> }[] = []
  const toolResults: { tool_use_id: string; text: string; isError: boolean }[] = []

  for (const part of message.content) {
    const text = textOfPart(part)
    if (text !== undefined) {
      texts.push(text)
      continue
    }
    if (part.type === "tool-call") {
      toolUses.push({
        tool_use_id: part.id,
        tool: part.namespace ? `${part.namespace}/${part.name}` : part.name,
        input: inputRecord(part.input),
      })
      continue
    }
    if (part.type === "tool-result") {
      const { text: resultText, isError } = toolResultText(part.result)
      toolResults.push({ tool_use_id: part.id, text: resultText, isError })
    }
  }

  const text = texts.join("\n")
  if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
    return undefined
  }
  return {
    role: role === "user" ? "user" : "assistant",
    text,
    toolUses,
    ...(toolResults.length > 0 ? { toolResults } : {}),
  }
}

/**
 * Converts the compaction transcript. Index alignment matters: `collectToolCalls`
 * records `callIndex` / `resultIndex` into this array, and `applyDecisions`
 * returns the same object identities for untouched messages — both rely on
 * positions, so this must be a 1:1 map with no filtering.
 *
 * Messages with nothing extractable become empty placeholders
 * (`{ role, text: "", toolUses: [] }`) so indices stay aligned.
 */
export function toLibraryMessages(messages: readonly Message[]): LibraryMessage[] {
  return messages.map((message) => {
    const converted = toLibraryMessage(message)
    if (converted) return converted
    const role = message.role === "user" ? "user" : "assistant"
    return { role, text: "", toolUses: [] as LibraryMessage["toolUses"] }
  })
}
