# Clean & Professional OpenCode Plugin — Maintenance Guide

> For: this repo (`opencode-jev-compaction`) and every future OpenCode V2 Effect plugin I build.
> Sources cross-validated 2026-09-26:
> - OpenCode V2 docs: `EFFECT_PLUGIN_GUIDE.md` §§1–14 (`/build/plugins`, `/build/plugins/effect`, `/build/plugins/rpc`, `/effect/rpc`, `/cli`, `/migrate-v1`, `/plugins`, `/cli/plugins`, `/compaction`, `/api`, `/build/client*`, `/build/sdk*`)
> - Skills installed: `clean-code` (Uncle Bob), `codebase-design` (deep modules + DEEPENING.md), `typescript-advanced-types` (+ `references/details.md`), `code-review` (Standards × Spec + Fowler smells), `typesafe-ai`, `opencode`
> - Web 2026 consensus: flat `src/` + feature folders, `strict` tsconfig, ESM (`type:module`), barrel `index.ts`, tests beside or under `tests/`, lint+format+typecheck in CI

---

## 1. The contract (OpenCode constraints win over generic TS advice)

These are non-negotiable; generic "clean TS" advice is adapted to fit them:

| # | OpenCode rule | What it forces on code shape |
|---|---|---|
| 1 | `Plugin.define({ id, effect })` default export; stable unique `id` (storage is scoped by it) | One `src/index.ts` that does **only wiring** — no business logic inline |
| 2 | Transform callbacks are **sync** `(editor) => void`. Never return Effect/Promise inside. Replayed on fresh state in registration order | Transforms must be **cheap, pure, repeatable**. All I/O **before** registration; captured data refreshed via `reload()` |
| 3 | `effect` runs in a `Scope` closed on reload/unload | No bare `fork` / `setInterval` / `AbortController` without scope. Background work = `Effect.repeat(...).pipe(Effect.forkScoped)` + `Effect.addFinalizer`. Promise flavor: return cleanup fn |
| 4 | `ctx.options` is `unknown` | Dedicated `src/options.ts` that narrows + validates (Effect `Schema` or guards). No `as any`, no unchecked property access |
| 5 | Tool effective names `namespace_name`, dots/illegal chars → `_`; later registration for same name wins; snapshots per model request | `src/tools/*` owns names explicitly; `update`/`remove` use effective names; schemas replaced by assignment, never mutated nested |
| 6 | Hooks run in plugin order, later sees earlier | Hooks are thin adapters; decisions live in testable pure modules. Never rely on being first/last |
| 7 | Local loads: `.opencode/plugins/` auto; `plugins/` at root NOT auto; publishable `package.json` exports `".": "./src/index.ts"` (+ `"./rpc"` when sharing RPC), deps `@opencode/plugin` + pinned `effect` | Repo layout must keep `src/` as the distributable root; dev harness under `.opencode/plugins/` points at it, never duplicates it |
| 8 | Test the **installed** tarball, not just linked copy (`bun pm pack` → `bun add ./x.tgz`); `touch` or `service restart` to reload | `README` documents pack-and-install verification; CI runs `typecheck`, `pack --dry-run` at minimum |
| 9 | Undocumented context (`ctx.aisdk`, `experimental.terminal.read`) | Do **not** use without checking `openapi.json`/source. If docs missing, say so — never guess V2 shapes from `config.json` schema or V1 pages |

---

## 2. Canonical layout (Bun + TS-direct, no `dist` for plugins)

OpenCode loads **TS source directly** — there is no compile step at load time. So unlike a 2026 Node service (`src/` → `dist/`), the plugin's `src/` **is** the artifact. Keep it that way.

```
opencode-jev-compaction/
├── src/
│   ├── index.ts            # ONLY Plugin.define + wiring. <60 lines. No logic.
│   ├── options.ts          # Options schema + narrow(ctx.options). Deep module §5.
│   ├── plugin-id.ts        # export const PLUGIN_ID = "jev.compaction" (single source)
│   ├── compaction/
│   │   ├── index.ts        # barrel: hook registration only
│   │   ├── hook.ts         # session "compaction" hook adapter (mutates event, calls service)
│   │   └── summary.ts      # pure: messages → summary input (no Jev, no ctx)
│   ├── jev/
│   │   ├── index.ts        # barrel
│   │   ├── client.ts       # Jev/SystemOne call (port: interface + injected fetch)
│   │   └── questions.ts    # Noul/Choice/Score definitions (typed, versioned)
│   ├── tools/              # (if any) one file per tool + index.ts barrel
│   ├── rpc.ts              # ONLY if sharing RPC contract (exported as ./rpc)
│   └── lib/
│       ├── effect-log.ts   # tiny logging helpers (optional)
│       └── schema.ts       # shared Effect Schemas
├── tests/
│   ├── compaction/summary.test.ts
│   └── jev/questions.test.ts
├── .opencode/
│   └── plugins/
│       └── jev-compaction/ # thin dev shim → re-export ../../src (never copy logic)
├── opencode.jsonc          # local dev config (plugins entry + options)
├── package.json            # name, version, type:module, exports {".", "./rpc"?}, deps
├── tsconfig.json           # strict (see §3)
├── eslint.config.js + .prettierrc (or biome.json) — pick ONE formatter, enforce in CI
├── README.md               # what it does, config, dev loop, publish steps
├── EFFECT_PLUGIN_GUIDE.md  # OpenCode API reference (already in repo — don't duplicate)
└── PLUGIN_MAINTENANCE_GUIDE.md  # this file — the only process doc
```

Rules:

- **One module, one folder, one barrel.** Each folder has `index.ts` re-exporting its public surface; internals stay unimportable by convention (`./internal/*` or non-exported files).
- **Feature folders, not layer folders.** Prefer `compaction/`, `jev/` over `controllers/`, `services/`, `utils/`. A `utils/` that keeps growing is a smell — promote clumps to a named module.
- **File names:** `kebab-case.ts` for files, `PascalCase` for classes/types-as-values, `camelCase` for functions/vars. One primary export per file + its directly-related types.
- **Relative imports use `.js` suffix** (`./rpc.js`, `./hook.js`) — required so the same source works under Bun runtime + bundler resolution + published package. (`allowImportingTsExtensions` is for type-only hops; runtime imports stay `.js`.)
- **No `dist/` committed.** `dist/` gitignored if you ever emit (only for packing checks). Local dev and OpenCode load `src/`.

---

## 3. TypeScript config (strict is mandatory)

Keep the repo's Bun-friendly base, tighten what is currently loose:

```jsonc
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",              // Node 22+ / Bun: everything in ES2025+
    "module": "Preserve",            // Bun + OpenCode TS-direct: do NOT emit nodenext here
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,    // import type vs import — enforced
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true, // keep — catches editor.list()[i] bugs
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true, // ADD
    "noImplicitReturns": true,                // ADD
    "noUnusedLocals": true,                   // TURN ON (currently false)
    "noUnusedParameters": true,               // TURN ON (currently false)
    "exactOptionalPropertyTypes": true        // ADD when effect version allows
  }
}
```

Type rules (from `typescript-advanced-types`, adapted):

1. `unknown` over `any` — always. Narrow with guards/`Schema.decodeUnknown`, never `as`.
2. `interface` for object shapes and editor drafts; `type` for unions, mapped/conditional/template-literal types, IDs (`type PluginID = ...`).
3. Public functions: explicit param + return types. Private helpers: let inference work, but annotate boundaries (hook callbacks, tool `execute`, RPC handlers).
4. `satisfies` for config-shaped objects (keeps literals for refactors):
   `const q = {...} satisfies ScoreDefinition`.
5. Branded IDs via Schema (`Skill.ID.make`, `Provider.ID.make`) — never raw strings across seams.
6. Discriminated unions for outcomes (`{ status: "ok", summary } | { status: "skip" } | { status: "fail", reason }`), exhaustive `switch` with `default` that throws/`never`.
7. Prefer `readonly`, `Readonly<>`, `as const` for criteria/legends/levels. Never mutate a captured transform input — copy on write.
8. Template-literal types for structured strings (event names, storage keys: `` `cache/${string}` ``).
9. Document complex types with one-line JSDoc stating the **interface contract** (invariants, error modes), not restating the signature.

---

## 4. Clean-code rules (Uncle Bob, enforced at review)

- **Names reveal intent:** `summarizeTranscriptWithJev`, `isCompactionWorthSkipping`, `elapsedTokens` — not `data`, `tmp`, `mgr`, `info` (unless the domain term). Boolean = `is/has/should`. Functions = verbs. Modules = nouns. If no honest name comes, the design is murky — redesign, don't comment.
- **Functions < 20 lines, one thing, one abstraction level.** `index.ts` wires; `hook.ts` adapts; `summary.ts` computes; `client.ts` calls network. Regex/string-munging never sits next to policy decisions — push it down one function.
- **0–2 args; 3+ must be an object.** Never boolean flags — split into two functions or a discriminated option (`{ mode: "native" } | { mode: "summary" }`).
- **No hidden side effects.** A function named `buildSummaryInput` must not call Jev, log, or touch storage. Side effects live in `hook.ts`/`client.ts` and are visible in the name (`emitUpdatedEvent`, `persistSettings`).
- **No `null` returns; no magic numbers.** Return `undefined` only for absent lookups (`editor.get` style) or a discriminated result. Name thresholds (`const LOW_CONFIDENCE = 0.5` with a comment citing the tuning source).
- **Comments explain *why*, never *what*.** Delete redundant/mandated noise. Legal/TODO/regex-intent/external-quirk comments only.
- **Newspaper formatting:** `src/index.ts` reads top-down (define → effect → registrations). Details sink to leaf files; callers never scroll past implementation to find the interface.

---

## 5. Deep modules (codebase-design vocabulary — use these words)

Design every folder as a **module** with a small **interface** at a deliberate **seam**. Depth = leverage for callers + locality for maintainers.

- **The interface is the test surface.** If a test must reach past the interface, the module is the wrong shape. Tests import the barrel, assert observable outcomes, survive refactors.
- **Accept dependencies, don't create them.** `summarize(messages, jev: JevPort)` — never `new JevClient()` inside. Same for `fetch`, clock, storage. Production adapter injected at `index.ts`; tests inject in-memory/fake adapters.
- **Return results, don't produce side effects.** `decideCompaction(input): Decision` returns data; `hook.ts` applies it to `event.result`. Pure core, thin adapters.
- **One adapter = hypothetical seam; two = real.** Don't add a port for Jev until you have prod + fake/test adapters — here you do (network vs deterministic fixture), so the port is justified.
- **Deletion test:** delete `jev/` — if compaction logic scatters across hooks, it was earning its keep; if nothing breaks, it was pass-through — inline it.
- **Internal vs external seams:** `jev/client.ts` may have internal seams (retry helper) used only by its own tests; never export them through `jev/index.ts`.
- **Classify the dependency, then test accordingly** (DEEPENING.md): pure compute (`summary.ts`) → direct tests, no adapter. Local-substitutable (storage JSON) → in-memory fake. Remote-but-owned / true-external (Jev HTTP) → port + in-memory adapter in tests, HTTP adapter in prod. **Replace, don't layer:** once interface tests exist, delete the old unit tests on the shallow pieces they absorbed.

Concrete seams for this repo:

```
src/compaction/hook.ts   (adapter: OpenCode event → Decision)
src/compaction/summary.ts (deep module: messages → SummaryInput | Skip)
src/jev/client.ts        (adapter: JevPort → HTTP; test double: fixture map)
src/jev/questions.ts     (deep module: policy wording lives here, versioned)
src/options.ts           (deep module: unknown → ValidatedOptions | default)
```

---

## 6. File templates (copy, don't improvise)

### `src/index.ts` — wiring only

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { PLUGIN_ID } from "./plugin-id.js"
import { registerCompactionHook } from "./compaction/index.js"
import { parseOptions } from "./options.js"

export default Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* parseOptions(ctx.options).pipe(Effect.orDie)
      yield* registerCompactionHook(ctx, options) // forkScoped inside if it subscribes
      yield* Effect.logInfo("plugin loaded", { id: PLUGIN_ID, version: ctx.app.version })
      yield* Effect.addFinalizer(() => Effect.logInfo("plugin unloaded", { id: PLUGIN_ID }))
    }),
})
```

### `src/options.ts` — narrow once

```ts
import { Schema } from "effect"

const Options = Schema.Struct({
  strict: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export const parseOptions = (raw: unknown) =>
  Schema.decodeUnknown(Schema.Struct({}).pipe(Schema.extend(Options)))({ ...(raw as object ?? {}) })
// On failure: fall back to defaults + log — never throw from wiring except via orDie with context.
```

### `src/compaction/hook.ts` — thin adapter

```ts
// One abstraction level: read event → decide (pure) → act (effect). No scoring strings here.
export const registerCompactionHook = (ctx: Context, options: Options) =>
  ctx.session.hook("compaction", (event) =>
    Effect.gen(function* () {
      const decision = decideCompaction(event.messages) // pure, tested
      if (decision.status !== "summarize") return // fall through to model call
      const summary = yield* summarizeWithJev(decision.input, options) // port, injected/fakeable
      event.result = { summary }
    }),
  )
```

---

## 7. OpenCode-specific hygiene (the things generic guides get wrong)

1. **Transform callback stays sync.** Load (`loadFromSource`), then `yield* ctx.x.transform((e) => {...})`. Never `await`/Effect inside. Refresh via captured-mutable + `forkScoped` loop + `reload()`.
2. **Tool hygiene:** `namespace()` first; names explicit; `update` replaces schemas by assignment; verify effective name (`_` sanitization); `reload()`/`dispose()` affect future snapshots only — document that in the tool's JSDoc.
3. **Hook hygiene:** `compaction` — set `event.result` to skip, leave unset to fall through (your Jev fallback path). `prompt` — retry-safe, runs once at admission, no provider scope. `retry` — attempt 1 = initial; built-in max is a hard wall. `permission "evaluate"` — skipped on explicit `deny`.
4. **Event hygiene:** `Stream` + `forkScoped`, filtered early; live-only (no replay) — never use events for exactly-once side effects.
5. **Storage hygiene:** keys namespaced by intent (`settings`, `cache/<id>`), JSON-only, `scan({ prefix, limit })` paginated. Storage is per-plugin-ID — renaming `id` orphans data (document migrations).
6. **RPC hygiene:** `Rpc.define` in `src/rpc.ts`, errors in `errors` map + `context.error`, events = objects only, `rpc.` prefix reserved. Export `"./rpc"` so others import the contract without the impl.
7. **TUI separation:** server (`src/index.ts`) vs terminal (`src/tui.tsx`, `@opencode/plugin/tui`, `/** @jsxImportSource @opentui/solid */`, `"./tui"` export, OpenTUI/Solid peers). Never import TUI types into server code.
8. **Config precedence awareness:** global → ancestor → direct → `.opencode/`; arrays merge. Document which file your `options` example belongs in. `cli.json` only for CLI-local plugins.

---

## 8. Review gate (code-review skill — run before every merge)

Two axes, reported separately, never merged:

- **Standards** (this file + repo docs + smell baseline below). **Spec** (the originating issue/spec — quote its lines).
- Repo standard **overrides** the baseline. Baseline smells are **judgement calls** (label "possible X"), never hard violations. Skip anything tooling enforces.

Smell baseline to check each diff (Fowler ch.3): Mysterious Name · Duplicated Code · Feature Envy · Data Clumps (→ new type) · Primitive Obsession (→ small type) · Repeated Switches (→ map/polymorphism) · Shotgun Surgery (→ gather) · Divergent Change (→ split) · Speculative Generality (→ delete) · Message Chains `a.b().c().d()` (→ hide behind one method) · Middle Man (→ cut) · Refused Bequest (→ composition).

Pre-merge checklist (all must be true):

- [ ] `bunx tsc --noEmit` clean; linter + formatter clean; no `any`, no unused locals/params
- [ ] `src/index.ts` still wiring-only (<60 lines); no logic leaked into hook/transform callbacks
- [ ] Transforms sync/pure/repeatable; external loads before registration; `reload()` wired for every captured input
- [ ] Background work `forkScoped` + finalizer; verified via `opencode service restart` (no orphan timers/sockets)
- [ ] Options narrowed in `options.ts`; no `as any`; defaults documented in README
- [ ] Tool names/effective names verified; RPC errors via `context.error`; events live-only assumptions stated
- [ ] Tests at the **interface** (barrel imports, outcome assertions); internal-refactor survival check done; absorbed shallow-module tests deleted
- [ ] Pack test: `bun pm pack` → install tarball into scratch config → `opencode service restart` → exercise every hook/tool/event → unload cleanly
- [ ] Standards and Spec findings listed separately with worst-per-axis noted

---

## 9. Daily loops

```sh
bun install
bunx tsc --noEmit          # typecheck (add: bun run typecheck)
bunx eslint .              # lint (add: bun run lint)
bun run test               # unit/interface tests (bun test / vitest)
touch .opencode/plugins/jev-compaction/index.ts  # reload dev plugin
opencode service restart && opencode service status
opencode api get /api/info
OPENCODE_LOG_LEVEL=DEBUG opencode   # one repro only
bun pm pack && bun add ./opencode-jev-compaction-*.tgz  # pre-publish proof
```

Versioning: semver; pin `effect` to the OpenCode-targeted release; on OpenCode contract change, ship a compatible plugin update and note it in README + CHANGELOG.

---

## 10. What NOT to do (cross-validated anti-list)

- Don't put business logic in `src/index.ts`, transform callbacks, or hook bodies — they are replayed/re-run; keep them adapters.
- Don't `setInterval`/bare `fork`/untracked `AbortController` — scope owns lifetime.
- Don't infer V2 shapes from `config.json` schema, V1 docs, or web search when V2 docs + `openapi.json` + source disagree — state the uncertainty.
- Don't use `ctx.aisdk` / `experimental.terminal.read` without source verification (undocumented).
- Don't over-abstract: one adapter = inline it; speculative generality deleted, not "kept just in case".
- Don't test internals: if a refactor breaks tests without changing behavior, the tests were past the interface — rewrite them at the seam.
