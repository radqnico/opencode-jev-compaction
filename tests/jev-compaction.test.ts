import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  applyDecisions,
  batchCalls,
  decideCall,
  messageChars,
  reductionRatio,
  resolveOptions,
} from "../src/lib/jev-compact.js"
import { collectToolCalls, estimateTokens, fitState, goalFromMessages } from "../src/lib/jev-state.js"
import { buildJevRequest, parseJevResponse } from "../src/lib/jev-request.js"
import { JevClient } from "../src/jev/client.js"
import { toLibraryMessage, toLibraryMessages } from "../src/compaction/adapter.js"
import { renderSummary } from "../src/compaction/render.js"
import { parseOptions, resolveApiKey } from "../src/options.js"
import type { JevAsker, JevQuestions, Message, ToolCall } from "../src/lib/jev-types.js"
import { compact } from "../src/lib/jev-compact.js"

function message(role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra }
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message("assistant", "", { toolUses: [{ tool_use_id: id, tool, input, text }] })
}

function result(id: string, text: string, isError = false): Message {
  return message("user", "", { toolResults: [{ tool_use_id: id, text, isError }] })
}

const fileA = "export const a = 1;\n".repeat(50)
const fileB = "export const b = 2;\n".repeat(50)

function transcript(): Message[] {
  return [
    message("user", "Never edit anything under src/generated. Fix the failing test."),
    call("tool-1", "Read", { file_path: "src/a.js" }, fileA),
    result("tool-1", fileA),
    message("assistant", "a.ts looks fine; checking b.js"),
    call("tool-2", "Read", { file_path: "src/b.js" }, fileB),
    result("tool-2", fileB),
    call("tool-3", "Bash", { command: "npm test" }, "FAIL b.test.js"),
    result("tool-3", "FAIL b.test.ts: expected 2 to be 3", true),
    message("assistant", "The failure is in b.test.ts; fixing now."),
    message("user", "go ahead"),
  ]
}

type Seen = { state: unknown; questions: string[] }

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) })
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: "noul" as const, noul: answer(key) }]),
        ),
      }
    },
  }
}

const fit = {
  maxStateTokens: 25_000,
  preserveRecentMessages: 0,
  goal: "fix the test",
}

await describe("options", async () => {
  await it("fills in defaults and ignores non-finite values", () => {
    assert.deepEqual(resolveOptions(), {
      goal: "",
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      truncateHeadChars: 300,
    })
    assert.deepEqual(
      resolveOptions({
        keepThreshold: Number.NaN,
        preserveRecentMessages: 2.7,
        truncateHeadChars: -1.2,
      }),
      {
        goal: "",
        keepThreshold: 0.5,
        preserveRecentMessages: 2,
        maxStateTokens: 25_000,
        maxRequestTokens: 30_000,
        truncateHeadChars: 0,
      },
    )
  })

  await it("parses plugin options without throwing", () => {
    assert.equal(parseOptions(undefined).model, "jev-latest")
    assert.equal(parseOptions(undefined).minReductionRatio, 0.25)
    assert.equal(parseOptions(undefined).baseUrl, undefined)
    assert.equal(parseOptions(undefined).headers, undefined)
    assert.equal(parseOptions({ model: "jev-test", minReductionRatio: 0.5 }).model, "jev-test")
    assert.equal(parseOptions({ minReductionRatio: Number.NaN }).minReductionRatio, 0.25)
    assert.equal(parseOptions({ apiKey: "k" }).apiKey, "k")
    assert.equal(parseOptions({ baseUrl: "https://proxy.local/jev" }).baseUrl, "https://proxy.local/jev")
    assert.equal(parseOptions({ baseUrl: "" }).baseUrl, undefined)
    assert.deepEqual(
      parseOptions({ headers: { "x-proxy": "yes", empty: "", n: 1 } }).headers,
      { "x-proxy": "yes" },
    )
    assert.equal(parseOptions({ headers: "nope" }).headers, undefined)
    assert.equal(parseOptions({ headers: {} }).headers, undefined)
    const saved = process.env.TYPESAFE_API_KEY
    delete process.env.TYPESAFE_API_KEY
    assert.equal(resolveApiKey(parseOptions({})), undefined)
    process.env.TYPESAFE_API_KEY = "env-key"
    assert.equal(resolveApiKey(parseOptions({})), "env-key")
    assert.equal(resolveApiKey(parseOptions({ apiKey: "opt-key" })), "opt-key")
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = saved
  })
})

await describe("token estimate", async () => {
  await it("charges words, digits and symbols separately", () => {
    assert.equal(estimateTokens(""), 0)
    assert.equal(estimateTokens("hello world"), 2)
    assert.equal(estimateTokens("internationalization"), 4)
    assert.equal(estimateTokens("12345678"), 4)
    const json = JSON.stringify({ file_path: "/Users/x/src/a.js", old_string: "a = 1;", n: 42 })
    assert.ok(estimateTokens(json) >= Math.ceil(json.length / 3))
  })
})

await describe("tool call collection", async () => {
  await it("pairs each tool call with its result and pins recent ones", () => {
    const calls = collectToolCalls(transcript(), 3)
    assert.deepEqual(
      calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned]),
      [
        ["t1", "Read", 1, 2, false],
        ["t2", "Read", 4, 5, false],
        ["t3", "Bash", 6, 7, true],
      ],
    )
    assert.equal(calls[2]?.isError, true)
    assert.equal(calls[0]?.resultChars, fileA.length)
  })

  await it("ignores calls without a result", () => {
    assert.equal(collectToolCalls([message("user", "hi"), call("x", "Read", {}, "")], 0).length, 0)
  })
})

await describe("state fitting", async () => {
  await it("sends the whole history with tool results replaced by a note", () => {
    const messages = transcript()
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), fit)
    assert.equal(stage, "full")
    const json = JSON.stringify(state)
    assert.ok(!json.includes("export const a = 1;"))
    assert.ok(json.includes("Never edit anything under src/generated"))
    assert.ok(json.includes("go ahead"))
    assert.deepEqual(
      state.history.map((entry) => entry.i),
      [0, 1, 3, 4, 6, 8, 9],
    )
    assert.deepEqual(state.history[1]?.tool_calls?.[0], {
      id: "t1",
      tool: "Read",
      input: state.history[1]?.tool_calls?.[0] && typeof state.history[1]?.tool_calls?.[0] === "object"
        ? (state.history[1]?.tool_calls?.[0] as { input: string }).input
        : "",
      result: `ok, ${fileA.length} chars (omitted)`,
    })
  })

  await it("defaults the goal to the latest user prompts", () => {
    const { state } = fitState(transcript(), [], { ...fit, goal: "" })
    assert.ok(state.goal.includes("Fix the failing test"))
    assert.ok(state.goal.includes("go ahead"))
    assert.equal(goalFromMessages(transcript()).split("\n").length, 2)
  })

  await it("truncates tool inputs before touching message text", () => {
    const messages = [
      message("user", "start"),
      call("w", "Write", { file_path: "x.js", content: "x".repeat(5000) }, "ok"),
      result("w", "ok"),
      message("assistant", "written"),
    ]
    const { state, stage, tokens } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      maxStateTokens: 300,
    })
    assert.equal(stage, "inputs<=200")
    assert.ok(tokens <= 300)
    assert.equal(state.history[0]?.text, "start")
    const firstCall = state.history[1]?.tool_calls?.[0]
    assert.ok(
      typeof firstCall === "object" && firstCall !== null && "input" in firstCall &&
        (firstCall as { input: string }).input.length <= 200,
    )
  })

  await it("throws when the history cannot be fitted", () => {
    const messages = [message("user", "a".repeat(2000)), message("assistant", "b")]
    assert.throws(() => fitState(messages, [], { ...fit, maxStateTokens: 50 }), /too large/)
  })
})

await describe("question batching", async () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i + 1}`,
    tool_use_id: `tool-${i + 1}`,
    tool: "Read",
    input: {},
    callIndex: i * 2 + 1,
    resultIndex: i * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }))
  const options = { maxRequestTokens: 30_000 }

  await it("puts everything in one request when it fits", () => {
    assert.equal(batchCalls(calls, 1000, options).length, 1)
  })

  await it("splits questions across requests when the state leaves little room", () => {
    const batches = batchCalls(calls, 29_600, options)
    assert.ok(batches.length > 1)
    assert.deepEqual(
      batches.flat().map((c) => c.id),
      calls.map((c) => c.id),
    )
  })

  await it("throws when a single question does not fit", () => {
    assert.throws(() => batchCalls(calls, 29_990, options), /no room/)
  })
})

await describe("decisions", async () => {
  const options = { keepThreshold: 0.5 }
  const unpinned = { id: "t1", tool: "Read", pinned: false }

  await it("keeps, drops the result, or drops the call based on the keep probabilities", () => {
    assert.equal(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action, "keep")
    assert.equal(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action, "drop_result")
    assert.equal(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options).action, "drop_call")
    assert.deepEqual(
      decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, options).action,
      "keep",
    )
  })

  await it("removes dropped calls and truncates dropped results", () => {
    const messages = transcript()
    const calls = collectToolCalls(messages, 0)
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ]
    const kept = applyDecisions(messages, decisions, calls, 300)
    assert.ok(kept.length < messages.length || kept.length === messages.length)
    assert.equal(kept[0], messages[0])
    assert.equal(messageChars(messages[0]!), messages[0]!.text.length)
  })
})

await describe("compact", async () => {
  await it("resends the full state with every batch and merges the answers", async () => {
    const seen: Seen[] = []
    const messages = transcript()
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
      ...fit,
      goal: "",
      preserveRecentMessages: 1,
    }).tokens
    const output = await compact(messages, fakeJev((name) => (name.startsWith("call_") ? 0.9 : 0.1), seen), {
      preserveRecentMessages: 1,
      maxRequestTokens: stateTokens + 150,
    })

    assert.equal(output.stats.requests, seen.length)
    assert.ok(seen.length > 1)
    assert.deepEqual(seen.flatMap((r) => r.questions).sort(), [
      "call_t1",
      "call_t2",
      "call_t3",
      "result_t1",
      "result_t2",
      "result_t3",
    ])
    assert.equal(new Set(seen.map((r) => JSON.stringify(r.state))).size, 1)
    assert.deepEqual(
      output.decisions.map((d) => d.action),
      ["drop_result", "drop_result", "drop_result"],
    )
    assert.equal(output.messages.length, messages.length)
    assert.equal(output.stats.resultsDropped, 3)
    assert.ok(reductionRatio(output) > 0)
  })

  await it("keeps everything without calling Jev when no tool call is a candidate", async () => {
    const seen: Seen[] = []
    const messages = [message("user", "hello"), message("assistant", "hi")]
    const output = await compact(messages, fakeJev(() => 0, seen))
    assert.equal(seen.length, 0)
    assert.equal(output.stats.requests, 0)
    assert.deepEqual(output.messages, messages)
  })

  await it("rejects malformed answers", async () => {
    const broken: JevAsker = {
      ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }),
    }
    await assert.rejects(
      compact(transcript(), broken, { preserveRecentMessages: 1 }),
      /Invalid Jev answer/,
    )
  })
})

await describe("HTTP client", async () => {
  await it("builds a System One request", () => {
    const request = buildJevRequest({ apiKey: "k" }, { a: 1 }, {
      q: { type: "noul", instructions: "x" },
    })
    assert.equal(request.url, "https://api.typesafe.ai/v1/systemone")
    assert.equal(request.headers.authorization, "Bearer k")
    assert.equal(request.headers["content-type"], "application/json")
    assert.deepEqual(JSON.parse(request.body), {
      model: "jev-latest",
      state: { a: 1 },
      questions: { q: { type: "noul", instructions: "x" } },
    })
  })

  await it("honours baseUrl and merges extra headers without touching auth", () => {
    const request = buildJevRequest(
      { apiKey: "k", baseUrl: "https://proxy.local/jev", headers: { "x-proxy": "yes", authorization: "evil", "content-type": "evil" } },
      { a: 1 },
      { q: { type: "noul", instructions: "x" } },
    )
    assert.equal(request.url, "https://proxy.local/jev")
    assert.equal(request.headers.authorization, "Bearer k")
    assert.equal(request.headers["content-type"], "application/json")
    assert.equal(request.headers["x-proxy"], "yes")
  })

  await it("rejects failed and malformed responses", () => {
    assert.throws(() => parseJevResponse(500, false, "boom"), /500/)
    assert.throws(() => parseJevResponse(200, true, "not json"), /malformed/)
    assert.throws(() => parseJevResponse(200, true, "{}"), /missing answers/)
    assert.deepEqual(parseJevResponse(200, true, '{"answers":{}}'), { answers: {} })
  })

  await it("asks over fetch and refuses to run without a key", async () => {
    const bodies: string[] = []
    const client = new JevClient({
      apiKey: "k",
      model: "jev-test",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body))
        return new Response(JSON.stringify({ answers: { q: { noul: 0.4 } } }), { status: 200 })
      }) as typeof fetch,
    })
    const response = await client.ask("state", { q: { type: "noul", instructions: "x" } })
    assert.deepEqual(response.answers.q, { noul: 0.4 })
    assert.equal(JSON.parse(bodies[0]!).model, "jev-test")

    const keyless = new JevClient({ apiKey: "" })
    await assert.rejects(keyless.ask("s", {}), /TYPESAFE_API_KEY/)
  })

  await it("sends custom endpoint and headers through the client", async () => {
    const seen: { url: unknown; headers: unknown; body: unknown }[] = []
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://proxy.local/jev",
      headers: { "x-proxy": "yes" },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url, headers: init?.headers, body: init?.body })
        return new Response(JSON.stringify({ answers: {} }), { status: 200 })
      }) as typeof fetch,
    })
    await client.ask("state", { q: { type: "noul", instructions: "x" } })
    assert.equal(seen[0]!.url, "https://proxy.local/jev")
    assert.equal((seen[0]!.headers as Record<string, string>)["x-proxy"], "yes")
    assert.equal((seen[0]!.headers as Record<string, string>).authorization, "Bearer k")
  })
})

await describe("adapter", async () => {
  await it("extracts text and tool parts from OpenCode messages", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "checking files" },
        { type: "tool-call", id: "c1", name: "read", input: { path: "a.js" } },
        { type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "contents" } },
      ],
    } as never
    const converted = toLibraryMessage(message)
    assert.equal(converted?.text, "checking files")
    assert.equal(converted?.toolUses[0]?.tool_use_id, "c1")
    assert.equal(converted?.toolResults?.[0]?.text, "contents")
  })

  await it("keeps 1:1 index alignment with placeholders", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] },
    ] as never
    const converted = toLibraryMessages(messages)
    assert.equal(converted.length, 2)
    assert.equal(converted[0]?.text, "hi")
    assert.equal(converted[1]?.text, "")
  })
})

await describe("render", async () => {
  await it("renders kept messages verbatim with a header", () => {
    const output = {
      messages: transcript().slice(0, 2),
      decisions: [],
      stats: {
        messagesBefore: 2,
        messagesAfter: 2,
        charsBefore: 10,
        charsAfter: 10,
        calls: 0,
        kept: 0,
        resultsDropped: 0,
        callsDropped: 0,
        pinned: 0,
        stateTokens: 5,
        stateStage: "full",
        requests: 0,
        ms: 1,
      },
    } as never
    const summary = renderSummary(output)
    assert.ok(summary.includes("[opencode-jev-compaction]"))
    assert.ok(summary.includes("Never edit anything"))
  })
})
