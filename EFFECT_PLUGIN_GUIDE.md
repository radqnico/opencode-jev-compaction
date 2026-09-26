# OpenCode V2 Effect Plugin Development Guide

> Source of truth: https://opencode.ai/v2/docs/build/plugins/effect/
> Companion: https://opencode.ai/v2/docs/build/plugins/ (Promise API), https://opencode.ai/v2/docs/plugins/ (loading/config), https://opencode.ai/v2/docs/build/plugins/effect/rpc/ (RPC)
> Scope: OpenCode **V2 only**. Do not use `https://opencode.ai/docs/` (V1) or `https://opencode.ai/config.json` schema to infer V2 shapes.

This guide is for building **Effect-native** plugins with `@opencode/plugin/effect`. Use it for all plugin work in this repo.

---

## 1. Effect vs Promise plugin — when to use which

| | Promise (`@opencode/plugin`) | Effect (`@opencode/plugin/effect`) |
|---|---|---|
| Entry | `Plugin.define({ id, async setup(ctx) {...} })` | `Plugin.define({ id, effect: (ctx) => Effect.gen(...) })` |
| Context ops | return `Promise` | return `Effect` or `Stream` |
| Callbacks (transform, hooks, tools) | `async` / sync functions | `Effect`-returning functions (transform callback itself stays sync — see §5) |
| Lifetime | `setup` may return `() => cleanup` | `effect` runs in a `Scope`; `Effect.addFinalizer` + `Effect.forkScoped` auto-cleanup on reload/unload |
| Errors | throw / reject | `Effect.fail`, `Effect.orDie`, typed errors (tools: `Tool.Error`, RPC: `context.error`) |
| Logging | `console.log` | `Effect.logInfo / logDebug / logWarning` |

**Rule:** use Effect plugin when you need typed errors, scoped background work (heartbeat, polling, event streams), `Stream` event subscription, Schema-typed tools/RPC, or composition with Effect libraries (e.g. TypeSafe Jev). Otherwise Promise plugin is fine.

---

## 2. Project setup

```sh
bun add @opencode/plugin effect
# effect version must match what OpenCode targets, e.g. effect@4.0.0-rc.111 — check docs for your release
```

`package.json` for a publishable plugin:

```json
{
  "name": "opencode-acme-effect-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@opencode/plugin": "latest",
    "effect": "4.0.0-rc.111"
  }
}
```

### 2.1 Where plugins load from

**Auto-loaded (no config):** any direct `.ts`/`.js` file or immediate package dir under a discovered `.opencode/plugins/`:

```
.opencode/plugins/concise.ts
.opencode/plugins/reviewer.js
.opencode/plugins/acme-package/  # must have package.json + default export
~/.config/opencode/plugins/       # same layout, global
```

**Explicitly configured** in `opencode.jsonc` (project, ancestor, or global `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-acme-effect-plugin",
    "opencode-acme-effect-plugin@1.2.0",
    "@acme/opencode-effect-plugin",
    "./plugins/local-effect",
    { "package": "@acme/opencode-effect-plugin", "options": { "agent": "reviewer", "strict": true } }
  ]
}
```

Notes:
- Relative paths resolve from the config file containing the entry.
- Plugin arrays merge across configs low→high precedence (global → ancestor → direct → `.opencode/`), they don't replace.
- `plugins/` next to project-root `opencode.jsonc` is **not** auto-discovered — configure it or move under `.opencode/`.
- Enable/disable with ordered IDs: `["*", "-opencode.provider.*", "opencode.provider.openai"]`. Builtins `opencode.config.policy` and `opencode.provider.opencode` ignore removals.
- Manage globals: `opencode plugin add|list|check|update|remove`. Reload: `touch .opencode/plugins/<name>/index.ts` or `opencode service restart`.

### 2.2 Minimal Effect plugin

```ts title=".opencode/plugins/concise/index.ts"
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "example",
  effect: (ctx) =>
    Effect.gen(function* () {
      const storage = ctx.storage
      yield* storage.set("loaded", true)
      yield* Effect.logInfo("Effect plugin loaded", { version: ctx.app.version })
    }),
})
```

`id` is required, must be unique. `ctx.app.version`, `ctx.location` (`directory`, `workspaceID?`, `project{id,directory,canonical}`) are always available.

---

## 3. Lifecycle & Scope

`effect` runs on load. Its `Scope` closes on reload/unload — registrations, `forkScoped` fibers, and finalizers release together.

```ts
export default Plugin.define({
  id: "lifecycle",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("loaded", { version: ctx.app.version })
      yield* Effect.addFinalizer(() => Effect.logInfo("unloaded"))
    }),
})
```

Background work **must** be `forkScoped` (never bare `fork` / `setInterval`):

```ts
import { Schedule } from "effect"

effect: (ctx) =>
  Effect.gen(function* () {
    yield* Effect.repeat(
      ctx.storage.set("heartbeat", { time: Date.now() }),
      { schedule: Schedule.spaced("1 minute") },
    ).pipe(Effect.forkScoped)
  })
```

All `transform` and `hook` calls return a scoped `Registration`:

```ts
type Transform<Input> = (callback: (input: Input) => void) => Effect.Effect<Registration, never, Scope.Scope>
// Registration.dispose removes that transform/hook and rebuilds from the rest. Idempotent.
```

---

## 4. Context — what you get

Effect `Context` = Effect client for the connected server + plugin-only transforms/hooks/storage/reload/options. It does **not** expose private Core services.

```ts
interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions              // unknown — narrow before use
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly event: EventDomain
  readonly experimental: { readonly terminal: Pick<ExperimentalApi<unknown>["persistentPty"], "read"> }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly model: ModelDomain
  readonly generate: GenerateApi<unknown>
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi<unknown>, "list">
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain              // + session.hook(...)
  readonly shell: ShellDomain                  // + shell.hook(...)
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain                    // + tool.hook(...)
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}
```

Client-style reads return `Effect` wrapping `{ data }` — always pipe `Effect.orDie` (or handle errors) before using `.data`:

```ts
const agents = yield* ctx.agent.list().pipe(Effect.orDie)
yield* Effect.logInfo("agents", { count: agents.data.length })
```

### 4.1 Options

```jsonc // opencode.jsonc
{ "plugins": [{ "package": "./plugins/company-effect", "options": { "strict": true } }] }
```

```ts
effect: (ctx) =>
  Effect.gen(function* () {
    const strict = ctx.options.strict === true // narrow unknown!
    yield* Effect.logInfo("company plugin configured", { strict })
  })
```

---

## 5. Transforms — the core mental model

1. Transforms **synchronously edit state through an editor**. Callback signature is `(editor) => void` — **never return Effect/Promise from inside**.
2. OpenCode applies transforms in **registration order within each domain**.
3. Order: sources contribute providers + immutable models first (`provider.transform`), then `model.transform` edits active-provider candidates.
4. Any registration/removal/`reload()` marks registry changed; next read **replays every active transform onto a fresh value**. Keep transforms **cheap, pure, repeatable**. Load external data **before** registering.
5. `yield*` the registration to keep it in plugin scope. `reload()` replays after captured inputs change (does not rerun plugin `effect`).

```ts
// Provider source
yield* ctx.provider.transform((editor) => {
  editor.add({ info, models }) // { info: Provider.Info, models: readonly Model.Info[], sourceConnection? }
})

// Policy over candidates
yield* ctx.model.transform((editor) => {
  editor.list().filter((m) => m.cost.some((t) => t.output > 20)).forEach((m) => editor.remove(m.providerID, m.id))
})

// Refresh loop
yield* Effect.repeat(
  Effect.gen(function* () {
    source.providers = yield* loadFromSource()
    yield* provider.reload() // provider reload also invalidates whole model result
  }),
  { schedule: Schedule.spaced("1 minute") },
).pipe(Effect.forkScoped)
```

---

## 6. Domain cookbook

### Agent — read / default / update / remove

```ts
const agents = yield* ctx.agent.list().pipe(Effect.orDie)
const build = yield* ctx.agent.get({ agentID: Agent.ID.make("build") }).pipe(Effect.orDie)

yield* ctx.agent.transform((editor) => {
  editor.default("build")
  editor.update("build", (item) => (item.description = "Builds features and fixes bugs"))
  editor.remove("legacy")
})
yield* ctx.agent.reload()
```

### Provider — add source, patch settings, replace inventory

```ts
import { Model, Provider } from "@opencode/plugin/effect"

const providerID = Provider.ID.make("acme")
const models = [{ ...Model.Info.default(providerID, Model.ID.make("reasoner")), name: "Acme Reasoner" }]
yield* ctx.provider.transform((editor) => {
  editor.add({
    info: { ...Provider.Info.empty(providerID), name: "Acme", activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:8000/v1" } },
    models,
  })
})

// patch
yield* ctx.provider.transform((editor) => {
  editor.update("anthropic", (p) => { p.headers = { ...p.headers, "x-company": "engineering" } })
  editor.models.update("anthropic", "claude-sonnet-4-5", (m) => (m.name = "Team Sonnet"))
  editor.models.remove("anthropic", "legacy-model")
  editor.remove("legacy-provider")
})

// account-specific discovery: pass sourceConnection so OpenCode excludes provider until refreshed
const connection = yield* ctx.integration.connection.active("acme")
if (connection) {
  const inventory = yield* loadInventory(connection)
  yield* ctx.provider.transform((editor) => {
    editor.add({ info: inventory.provider, models: inventory.models, sourceConnection: connection })
  })
}
```

### Model — policy over active candidates

```ts
const models = yield* ctx.model.list().pipe(Effect.orDie)
const selected = yield* ctx.model.default().pipe(Effect.orDie)

yield* ctx.model.transform((editor) => {
  editor.list("anthropic").forEach((m) => {
    editor.update(m.providerID, m.id, (draft) => { draft.enabled = draft.capabilities.tools })
  })
  editor.default.set("anthropic", "claude-sonnet-4-5")
  editor.remove("anthropic", "legacy-model")
})
// editor.provider.get("anthropic")?.models.get(...) reads IMMUTABLE source defs, not transform output
```

### Command — add-only

```ts
yield* ctx.command.transform((editor) => {
  editor.add({
    name: "security-review",
    description: "Review changes for security issues",
    execute: (input) =>
      ctx.session.prompt({
        ...input.prompt, sessionID: input.sessionID,
        text: `Review these changes for security issues.\n\n${input.prompt.text}`,
        delivery: input.delivery,
      }).pipe(Effect.asVoid),
  })
})
yield* ctx.command.reload()
```

### Session — create / prompt / generate / switch

```ts
const created = yield* ctx.session.create({ title: "Review" }).pipe(Effect.orDie)
yield* ctx.session.switchAgent({ sessionID: created.id, agent: Agent.ID.make("build") }).pipe(Effect.orDie)
yield* ctx.session.switchModel({
  sessionID: created.id,
  model: { providerID: Provider.ID.make("anthropic"), id: Model.ID.make("claude-sonnet-4-5") },
}).pipe(Effect.orDie)
yield* ctx.session.prompt({ sessionID: created.id, text: "Review the current changes" }).pipe(Effect.orDie)
const summary = yield* ctx.session.generate({ sessionID: created.id, prompt: "Summarize this project" }).pipe(Effect.orDie)
yield* ctx.session.command({ sessionID: created.id, command: "review", arguments: "--staged" }).pipe(Effect.orDie)
yield* ctx.session.synthetic({ sessionID: created.id, text: `Summary: ${summary.text}`, resume: false }).pipe(Effect.orDie)
```

`ctx.generate.text({ model, prompt })` generates without session/tools/history. `ctx.permission.{list,get,reply,rules}` manages approvals.

### Skill

```ts
import { Skill } from "@opencode/plugin/effect"
yield* ctx.skill.transform((editor) => {
  editor.add(Skill.Info.make({
    id: Skill.ID.make("review"), name: Skill.Name.make("Review"),
    description: "Review the current changes",
    location: "/workspace/.opencode/skills/review.md",
    content: "Review the current changes for correctness and missing tests.",
  }))
  editor.update("review", (item) => (item.autoinvoke = true))
  editor.remove("legacy")
})
yield* ctx.skill.reload()
```

### Reference

```ts
yield* ctx.reference.transform((editor) => {
  editor.add("handbook", { type: "local", path: "/workspace/docs/handbook" })
  editor.add("standards", { type: "git", repository: "https://github.com/acme/standards", branch: "main" })
  editor.remove("legacy")
})
yield* ctx.reference.reload()
```

### MCP — manage only via transform

```ts
yield* ctx.mcp.transform((editor) => {
  editor.set("docs", { type: "remote", url: "https://mcp.example.com" })
  editor.update("docs", (s) => (s.disabled = false)) // false=enable+connect, true=disable+disconnect
  editor.remove("legacy")
})
yield* ctx.mcp.reload()
```

### Storage — durable JSON scoped to plugin ID

```ts
yield* ctx.storage.set("settings", { strict: true })
const settings = yield* ctx.storage.get("settings")
yield* ctx.storage.remove("settings")
const page = yield* ctx.storage.scan({ prefix: "cache/", limit: 100 })
if (page.next) yield* ctx.storage.scan({ prefix: "cache/", after: page.next, limit: 100 })
```

### Tool — Schema-typed, namespaced

```ts
import { Schema } from "effect"

yield* ctx.tool.transform((editor) => {
  editor.namespace({ name: "acme", description: "Customer account tools" })
  editor.add({
    name: "greeting",
    description: "Create a greeting",
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({ greeting: Schema.String }),
    options: { namespace: "acme", codemode: true },
    execute: ({ name }, context) =>
      Effect.gen(function* () {
        yield* context.progress({ status: "greeting" })
        return { output: { greeting: `Hello ${name}!` } }
      }),
  })
})
```

Rules:
- Effective name = `namespace_name` with dots/unsupported chars → `_` (`acme_greeting`). `update`/`remove` use effective name.
- `transform` callback is sync; load data first. Later valid registration for same name overrides earlier.
- `yield* ctx.tool.reload()` after captured data changes. Snapshots are per-model-request; reload/dispose affect future snapshots only.
- `registration.dispose` removes that transform and rebuilds, revealing overridden defs.

### VCS / Websearch / Worktree / Integration

```ts
// VCS read + custom provider
const info = yield* ctx.vcs.get().pipe(Effect.orDie)
yield* ctx.vcs.transform((editor) => {
  editor.add({ id: "custom", name: "Custom VCS",
    info: () => Effect.succeed({ branch: { current: "feature", default: "main" } }),
    branches: (input) => readBranches(input),
    status: (scope) => readStatus(scope.worktree),
    diff: (input) => readDiff(input) })
  editor.default.set("custom")
})

// Websearch
const results = yield* ctx.websearch.query({ query: "OpenCode plugins", providerID: WebSearch.ID.make("internal") }).pipe(Effect.orDie)
yield* ctx.websearch.transform((editor) => {
  editor.add({ id: "internal", name: "Internal search", execute: ({ query }) => searchInternal(query) })
  editor.default.set("internal") // or `false` to disable
})

// Worktree strategy (local dirs only)
yield* ctx.worktree.transform((editor) => { editor.add(strategy) }) // last registration wins

// Integration: resolve credential, connect key, OAuth
const connection = yield* ctx.integration.connection.active("github")
const credential = connection ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orDie) : undefined
```

---

## 7. Events — subscribe as Stream, fork in scope

```ts
import { Stream } from "effect"

yield* ctx.event.subscribe().pipe(
  Stream.tap((item) => Effect.logDebug("OpenCode event", { type: item.type })),
  Stream.runDrain,
  Effect.forkScoped,
)

// filtered
yield* ctx.event.subscribe().pipe(
  Stream.filter((item) => item.type === "config.updated"),
  Stream.runForEach(() => Effect.logInfo("configuration changed")),
  Effect.forkScoped,
)
```

---

## 8. Hooks

Multiple plugins can register the same hook; they run in **plugin order**, later sees earlier changes. All return scoped `Registration`.

### 8.1 Session hooks (most used)

```ts
// Prompt admission — runs once at admission, before attach/skill resolution. No provider scoping.
// Synthetic/shell/compaction/move controls do NOT trigger it.
yield* ctx.session.hook("prompt", (event) =>
  Effect.sync(() => {
    event.prompt.text = event.prompt.text.replaceAll("company-secret", "[redacted]")
  }),
)

// Agent-loop context — mutate system/tools/options for outgoing call only (not persisted history)
yield* ctx.session.hook("context", (event) =>
  Effect.sync(() => {
    event.system.push({ type: "text", text: "Keep the review focused on correctness." })
    delete event.tools.write
  }),
)

// Compaction — THIS REPO'S CORE USE CASE: supply custom summary and skip model call
yield* ctx.session.hook("compaction", (event) =>
  Effect.map(summarize(event.messages), (summary) => {
    event.result = { summary } // set result to skip model call
  }),
)
// `generate` and `title` are analogous; `title` has no agent/tools and result is a string.

// Provider-scoped model request + native HTTP
yield* ctx.session.hook("model.request",
  (event) => Effect.sync(() => (event.headers["x-plugin"] = "review")),
  { providerID: "anthropic" })

yield* ctx.session.hook("http.request", (event) =>
  Effect.sync(() => {
    event.request.headers.set("x-session-id", event.sessionID)
    if (event.kind === "title") event.request.headers.set("x-priority", "background")
    // event.kind: "primary" | "compaction" | "title" | "generate"
  }),
)
// Bodies are one-shot streams — clone/replace before reading.

// Retry policy — runs after classification, before scheduling. Built-in max attempts still hard limit.
// attempt 1 = initial request, 2 = first retry. Invalid delays fall back to computed delay.
yield* ctx.session.hook("retry", (event) =>
  Effect.sync(() => {
    if (event.error.status === 429) event.decision = { retry: true, delay: 10_000 }
    else if (event.attempt >= 3) event.decision = { retry: false }
  }),
)

// Experimental WebSocket (may change): handshake/send/receive, provider-scoped
yield* ctx.session.hook("experimental.ws.handshake",
  (event) => Effect.gen(function* () {
    event.headers.authorization = `Bearer ${yield* mintToken(event.url)}`
  }),
  { providerID: "azure" })
```

Provider options use **semantic names** (`reasoningEffort`, `maxTokens`, `topK` where supported), not raw HTTP fields. `options` starts empty per call; overrides beat model defaults beat route defaults; objects merge recursively.

### 8.2 Shell & Tool hooks

```ts
// Shell — mutate command/cwd/timeout/shell/env before exec
yield* ctx.shell.hook("create.before", (event) =>
  Effect.sync(() => {
    if (event.command === "npm") event.command = "bun"
    event.timeout = Math.min(event.timeout, 60_000)
    event.env.COMPANY_ENV = "development"
  }),
)

// Tool — before may replace input or fail with Tool.Error; after may replace result
yield* ctx.tool.hook("execute.before", (event) =>
  event.tool === "write"
    ? Effect.fail(new Tool.Error({ message: "Writes are disabled" }))
    : Effect.logDebug("tool input", { tool: event.tool, input: event.input }),
)
yield* ctx.tool.hook("execute.after", (event) =>
  event.status === "error"
    ? Effect.logWarning("tool failed", { message: event.error.message })
    : Effect.sync(() => { event.result = { ...event.result, metadata: { observed: true } } }),
)
```

---

## 9. RPC — share methods/events with other plugins & clients

Define with Effect Schema (`src/rpc.ts`):

```ts
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

export const Acme = Rpc.define({
  id: "acme",
  methods: {
    search: {
      input: Schema.Struct({ query: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
      errors: { not_found: Schema.Struct({ query: Schema.String }) },
    },
  },
  events: { updated: { schema: Schema.Struct({ itemID: Schema.String, text: Schema.String }) } },
})
```

Implement + call from plugin `effect`:

```ts
import { Acme } from "./rpc.js"

const registration = yield* ctx.rpc.register(Acme, {
  search: ({ query }, context) =>
    findText(query).pipe(
      Effect.flatMap((text) =>
        text ? Effect.succeed({ text })
          : Effect.fail(context.error("not_found", "Result not found", { query }))),
    ),
}).pipe(Effect.orDie)

const acme = ctx.rpc(Acme)
const result = yield* acme.search({ query: "hello" })
yield* registration.events.emit("updated", { itemID: "item-1", text: result.text })

// subscribe (live only, closes when Stream stops)
yield* acme.events.subscribe("updated").pipe(
  Stream.runForEach((e) => Effect.logInfo(e.data.text)),
  Effect.forkScoped,
)
```

Call over HTTP from outside:

```ts
import { OpenCode } from "@opencode/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
const program = Effect.gen(function* () {
  const client = yield* OpenCode.make({ baseUrl: "http://localhost:4096" })
  return yield* client.rpc(Acme).search({ query: "hello" })
})
await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)))
```

Full RPC reference: https://opencode.ai/v2/docs/build/plugins/effect/rpc/ · CLI plugins: https://opencode.ai/v2/docs/build/plugins/cli

---

## 10. Publish & test

```sh
bun pm pack
bun add ./opencode-acme-effect-plugin-1.0.0.tgz
# test the INSTALLED package, not just workspace-linked copy; pin effect version to target OpenCode release
```

Checklist before publish:
- [ ] `Plugin.define({ id, effect })` default-exported from package entrypoint
- [ ] `options` narrowed (no `as any` on unknown)
- [ ] All transforms cheap/repeatable, external loads happen before callback
- [ ] All background loops/event subscriptions `forkScoped` + finalizer verified via `opencode service restart`
- [ ] `reload()` wired for every captured external input
- [ ] Tool effective names checked (`namespace_name`, `_` sanitization), `update` replaces schemas by assignment
- [ ] Hooks run in plugin order — verified later-hook visibility
- [ ] RPC errors declared in `errors` map, raised via `context.error`

---

## 11. Debug

```sh
opencode service status
opencode api get /api/info
opencode --standalone        # isolate shared-service issues
opencode service restart
OPENCODE_LOG_LEVEL=DEBUG opencode  # one repro when normal logs insufficient
# logs: ~/.local/share/opencode/log/opencode.log (filter role=cli vs role=server)
```

Do not delete/edit DB, service registration, or service config while diagnosing. Redact keys/headers/prompts before sharing.

---

## 12. Compaction-plugin starter (for this repo: opencode-jev-compaction)

```ts title=".opencode/plugins/jev-compaction/index.ts"
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "jev.compaction",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.session.hook("compaction", (event) =>
        Effect.gen(function* () {
          const summary = yield* summarizeWithJev(event.messages) // your Jev call
          event.result = { summary }
        }),
      )
    }),
})
```

Replace `summarizeWithJev` with a TypeSafe Jev judgment + `Effect.orDie`/fallback to model call (leave `event.result` unset to fall through).

---

## 13. Gaps closed 2026-09-26 — what the first draft missed

Sources read after first draft: `/build/plugins/rpc/`, `/build/plugins/cli/`, `/build/plugins/migrate-v1/`, `/build/`, `/build/client/`, `/build/client/effect/`, `/build/sdk/`, `/build/sdk/effect/`, `/build/sdk/cloudflare/`, `/plugins/`, `/cli/plugins/`, `/compaction/`, `/api/`, plus the truncated tail of `/build/plugins/` (permission/shell/tool hooks, publish, V1-dual support).

### 13.1 Promise-plugin tail (applies to Effect unless noted)

- **Permission hook** (`ctx.permission.hook("evaluate", ...)` in Promise; Effect equivalent is Effect-returning callback): runs for `allow`/`ask` only — explicit configured `deny` is final and skips hooks. May set `effect` to `allow|ask|deny`; `message` becomes escalation text or denial reason. Typical pattern: `session.context` + `generate.text` safety review → `event.effect`/`event.message`.
- **Session reference shapes**: `prompt` (mutable draft: `prompt{text,files,agents,skills}`, `metadata`, `delivery="steer"|"queue"`; IDs readonly; no provider scoping; runs once at admission; retry-safe, not exactly-once), `context/compaction/generate/title` (outgoing-call-only edits; `compaction.result={summary,providerState?,metadata?,tokens?}`, `title.result=string`), `model.request/http.request/http.response`, experimental `ws.handshake/send/receive` (may change), `retry` (`attempt` 1=initial; built-in max is hard limit).
- **Tool hook failures**: `execute.before` failure type is `Tool.Error`; `execute.after` never fails typed. Promise executors get `context.signal` — forward to `fetch` etc.
- **Publish**: also export `"./rpc": "./src/rpc.ts"` when sharing an RPC contract so consumers import it without loading the implementation. Dual V1+V2 support: `export default { ...Plugin.define({id, setup/effect}), async server() {...} }` (V1 calls `server()`, V2 reads `id`+`setup`/`effect`; OpenCode ≥1.18.29 for object form).
- **V1→V2 hook map** (from migrate-v1): `event→event.subscribe`, `tool map→tool.transform`, `auth→integration.transform`, `provider→provider+model transforms`, `chat.message→session "prompt"`, `chat.params→"context"`, `chat.headers→"model.request"/"http.request"`, `permission.ask→permission "evaluate"`, `tool.execute.before/after→same`, `shell.env→shell "create.before"`, `tool.definition→tool.transform`, `experimental.chat.system/messages.transform→"context"`, `experimental.session.compacting→"compaction"`. No 1:1 for `experimental.compaction.autocontinue/small_model/text.complete`, `command.execute.before` (own the command via transform or use prompt hook).

### 13.2 RPC — Promise flavor differences

- Same `Rpc.define({id, methods:{input,output,errors}, events})`, but schemas are **JSON Schema or any Standard Schema** (Zod/Valibot/ArkType). JSON Schema values are `unknown` — narrow before use; Standard Schema infers types. Effect Schema requires the Effect client.
- Error keys become `type`; names starting `rpc.` are reserved. Events: data must be objects (empty-object schema when no data); scalars/arrays/null invalid.
- Promise register: `ctx.rpc.register(Acme, { search: async (input, context) => ... })` with `context.signal` + `context.error(...)` (return or throw). One plugin may register several RPCs; dispose removes.
- Call from TUI plugin via `context.client.rpc(Acme)`; subscribe via `events.on(name, cb)` → unsubscribe, or `for await (...events.subscribe(name))`. Envelope type is prefixed (`rpc.acme.updated`), includes `data` + `location`. Live-only, no replay; unload closes subscriptions.
- Any HTTP client: `POST /api/rpc/{rpcID}/{method}` with `{"input":...}` → `{"output":...}`; omit input/output fields when empty.

### 13.3 Clients (for testing/RPC outside plugins)

- Promise `@opencode/client`: `OpenCode.make({baseUrl, headers?, fetch?})`, per-call `{signal, headers}`; streams are async iterables, lazy shared connection, live-only.
- Effect `@opencode/client/effect`: same but typed Effects/Streams + decoded schema values; RPC second arg `{location, signal, headers}`; errors in error channel; provide `FetchHttpClient.layer`.
- Local service (Node only): `Service.discover() / ensure({file, version, command, onStart}?) / stop()`, `Service.headers(endpoint)`; Effect version under `@opencode/client/effect/service` (+ `@effect/platform-node`).

### 13.4 SDK (embed OpenCode)

- Promise `@opencode/sdk`: `await using opencode = await OpenCode.create({plugins?})` (or `close()`); same values/streams as client + `sessions`/`events` aliases; `opencode.plugin(p)` post-startup; worktree ops need `projectID` (create/refresh load canonical config; list reads inventory; remove uses recorded strategy).
- Effect `@opencode/sdk/effect`: `Effect.scoped(... OpenCode.create() ...)`, `Stream` events `forkScoped`, `opencode.plugin(plugin)`, `OpenCode.layer()` for app service.
- Cloudflare `@opencode/sdk/workerd`: one host per Durable Object (`blockConcurrencyWhile`), SQLite storage, durable events, no local fs/process; `wrangler.jsonc` needs `nodejs_compat`.

### 13.5 CLI/TUI plugins (terminal UI, separate track)

- Import `@opencode/plugin/tui` (resolved at runtime), `Plugin.define({id, setup(context){...return cleanup}})`. Context: `options, location, app{version,channel}, client, renderer, theme, data.*, ui.*, storage, keymap, attention, markdown`.
- Capabilities: toasts/dialogs/routes/tabs/slots (`app,home.footer,status,prompt.footer,session.composer.top,sidebar.*,session.panel`), keymap layers (palette/slash/bind), model variant, `data.on/listen`, session/project/shell/location caches with `sync/list/get/invalidate`, durable + memory storage, path formatting.
- Packaging: `"./tui": "./src/tui.tsx"` export (+ OpenTUI/Solid peers for JSX) beside server entry; server-configured TUI plugins load automatically (even remote); `cli.json` `plugins` only for CLI-local plugins that stay active against remote servers. Discovery mirrors server: `<global>/plugins/<name>/{index.ts,tui.ts}`, `<project>/.opencode/plugins/<name>/{index.ts,tui.ts}`.

### 13.6 Compaction (directly relevant to this repo)

- Auto on by default: `{compaction:{auto:true, keep:{tokens:15000}, buffer:10% of limit}}`. `auto` also recovers once on provider too-long rejection; manual `POST /api/session/{id}/compact` (`{id?}` for idempotent retry) always works, runs at next safe point, merges concurrent requests; watch `session.compaction.*`.
- Layout: `[system][older …][recent 15k][pending]` → `[system][summary][recent 15k][pending]`; later compactions update same summary; summary covers objective/requirements/decisions/done+active/blockers+next/files; long tool output shortened, attachments described. Post-compaction, current instruction files become baseline.
- Providers: `providers.<id>.settings.compaction={type:"native"|"summary"}` (model overrides provider); native = provider-side encrypted checkpoint (OpenAI Responses; same provider+model+endpoint only; retries smaller on too-long, never falls back to summary).
- Limits: uses session's model (no separate model); needs replaceable older conversation (can't help `120k fixed + 8k conv` in 128k); overlong compact-sources get shortened, oldest dropped; one auto-recovery retry; stored history retained. V1 tail-turn/pruning → V2 `keep.tokens`.
- **For Jev plugin**: `compaction` hook's `messages` is the transcript being summarized; OpenCode appends its summary prompt *after* hooks; setting `event.result` skips the model call entirely — the interception point for Jev-produced summaries.

### 13.7 Config/plugin loading (ops)

- Precedence low→high: global `~/.config/opencode/opencode.jsonc` → ancestor `opencode.jsonc`s → current `opencode.jsonc` → `.opencode/opencode.jsonc`s; plugin arrays merge in that order. Relative paths resolve from containing config.
- Control: ordered IDs, `-` prefix disables, `*` all, `.*` prefix-match; later re-enables. `opencode.config.policy` + `opencode.provider.opencode` ignore removals.
- Manage: `opencode plugin add <npm|github:|git+ssh:…>[@ver] [--global?] | list [--builtin] | check | update [pkg] | remove <pkg>`; startup uses cached packages, installs missing in background, checks unpinned npm/Git; exact versions/full SHAs stay pinned. `touch .opencode/plugins/…` or `service restart` to reload; unwatched local deps may need restart.
- Debug: `service status`, `api get /api/info`, `--standalone` to isolate, `OPENCODE_LOG_LEVEL=DEBUG` one repro, `~/.local/share/opencode/log/opencode.log` (`role=cli|server`); never edit DB/registration while diagnosing; redact secrets.

## 14. Coverage statement — what was read vs what remains

- **Read (V2 docs, 2026-09-26)**: `llms.txt` index; `build/` intro; `build/plugins/` full incl. truncated tail; `build/plugins/effect/`; `build/plugins/rpc/`; `build/plugins/effect/rpc/`; `build/plugins/cli/`; `build/plugins/migrate-v1/`; `build/client/`; `build/client/effect/`; `build/sdk/`; `build/sdk/effect/`; `build/sdk/cloudflare/`; `plugins/`; `cli/plugins/`; `compaction/`; `api/` operation+schema index.
- **Not read**: remaining Configure/CLI/Console feature pages (`agents, models, skills, providers, websearch, permissions, policies, instructions, …`), `config`, `troubleshooting`, `migrate-v1` (server), full `api` schema bodies, `openapi.json`, source repos. Context items `aisdk` and `experimental.terminal.read` are exposed in the Effect `Context` type but have no dedicated section in the pages above — treated as undocumented here; verify against `openapi.json`/source before using.
- **Rule going forward**: V2 docs only (`/v2/docs/`); never infer V2 shapes from `config.json` schema or V1 pages; if docs missing/contradictory, say so and check source.
