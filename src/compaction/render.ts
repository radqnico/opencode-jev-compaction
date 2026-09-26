/**
 * Renders the pruned transcript as the compaction `summary`.
 *
 * OpenCode's `compaction` hook cannot return a message list — only
 * `event.result = { summary }`. So the Jev decisions are encoded as text:
 * everything kept stays verbatim (user/assistant text in order, kept tool
 * calls with input, kept results verbatim, truncated results as head + note).
 * Dropped calls vanish entirely. A header records the Jev stats so the next
 * agent knows what was removed and can re-run tools.
 */
import type { CompactResult, Message } from "../lib/jev-types.js"

function formatInput(input: Record<string, unknown>): string {
  let json = ""
  try {
    json = JSON.stringify(input)
  } catch {
    json = "[unserializable input]"
  }
  return json.length > 500 ? `${json.slice(0, 500)}…` : json
}

function renderMessage(message: Message): string {
  const lines: string[] = []
  const label = message.role === "user" ? "User" : "Assistant"
  if (message.text.trim().length > 0) {
    lines.push(`${label}: ${message.text}`)
  }
  for (const tool of message.toolUses) {
    lines.push(`${label} tool call: ${tool.tool}(${formatInput(tool.input)}) [id=${tool.tool_use_id}]`)
    if (tool.text !== undefined && tool.text.length > 0) {
      lines.push(`  mirrored result: ${tool.text}`)
    }
  }
  for (const result of message.toolResults ?? []) {
    const tag = result.isError ? "error " : ""
    lines.push(`${label} ${tag}tool result [id=${result.tool_use_id}]: ${result.text}`)
  }
  return lines.join("\n")
}

/** Builds the `summary` string stored as the compaction. */
export function renderSummary(result: CompactResult): string {
  const { stats, decisions } = result
  const kept = result.messages.map(renderMessage).filter((text) => text.length > 0)
  const decisionLines = decisions.map(
    (d) => `- ${d.id} ${d.tool}: ${d.action} (${d.reason}, keepCall=${d.keepCall.toFixed(2)}, keepResult=${d.keepResult.toFixed(2)})`,
  )
  return [
    "[opencode-jev-compaction] Verbatim transcript pruned by Jev — no model summary. " +
      `Kept ${stats.messagesAfter}/${stats.messagesBefore} messages, ` +
      `${stats.callsDropped} calls dropped, ${stats.resultsDropped} results truncated, ` +
      `${stats.kept} kept, ${stats.pinned} pinned. ` +
      `Jev state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s). ` +
      "Dropped tool outputs can be recovered by re-running the tool.",
    "",
    ...kept,
    "",
    "Jev decisions:",
    ...decisionLines,
  ].join("\n")
}
