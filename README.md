# opencode-jev-compaction

Verbatim Jev-guided compaction for OpenCode sessions. Ported from
[`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction)
(Claude Code plugin, MIT) — see `LICENSE-THIRD-PARTY.md` and
`docs/adaptation.md` for what was kept verbatim and what OpenCode's API forced
to change.

## What it does

Most compaction asks an LLM to summarize old turns. A summary is lossy: file
paths, exact errors, constraints, or commands can disappear even when they
matter later. This plugin never rewrites anything it keeps. It asks TypeSafe
Jev (two `noul` questions per tool call: should the call stay, should its
output stay verbatim), drops or truncates what Jev releases, and stores the
pruned transcript verbatim as the compaction. User and assistant text stays
in order.

On any failure (missing key, Jev error, unfittable history, or reduction
below `minReductionRatio`) it leaves `event.result` unset so OpenCode falls
back to its built-in model summary.

## Install

```sh
npm install
export TYPESAFE_API_KEY="..."
```

Local dev (this repo doubles as the plugin — `src/` is the artifact,
OpenCode loads TS directly):

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "./", "options": { "minReductionRatio": 0.25 } }],
}
```

Or via the auto-loaded shim: `.opencode/plugins/jev-compaction/index.ts`
re-exports `src/index.ts`.

## Options (`plugins[{ options }]`)

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key. Optional when the endpoint needs none (gateway/proxy without auth, local mock). Never commit it. |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | Custom System One endpoint (proxy, gateway, mock server) |
| `headers` | — | Extra HTTP headers merged into every Jev request, e.g. `{ "x-proxy-token": "..." }`. `authorization` and `content-type` always win and cannot be overridden. Non-string values are ignored. |
| `goal` | last 3 user prompts | Ongoing task description in the Jev state |
| `keepThreshold` | `0.5` | Minimum keep probability or the item is removed |
| `preserveRecentMessages` | `6` | Newest messages pinned (first is always pinned) |
| `maxStateTokens` | `25000` | Token ceiling for the Jev state |
| `maxRequestTokens` | `30000` | Ceiling for state + one batch of questions |
| `truncateHeadChars` | `300` | Chars of a dropped result retained before its note |
| `minReductionRatio` | `0.25` | Below this estimated reduction → built-in summary |

## Dev loop

```sh
npm run typecheck
node /tmp/run-tests.mjs
touch .opencode/plugins/jev-compaction/index.ts  # reload dev plugin
opencode service restart && opencode service status
```

Docker clean-room harness (fresh container, isolated HOME, pinned binary):

```sh
docker compose -f docker/compose.yml run --rm harness all   # full suite
docker compose -f docker/compose.yml run --rm harness run   # + serve/session/compact E2E
TYPESAFE_API_KEY=... docker compose -f docker/compose.yml run --rm harness run  # live Jev path
```

See `docker/README.md` for stages, limits, and version pinning.

Tests run on `node:test` + `node:assert/strict` (no vitest): pure suites for
options/tokens/collection/fitting/batching/decisions/`compact`/HTTP plus
adapter (OpenCode → library shapes, index alignment) and render (verbatim
header) suites. The Jev network boundary is a fake `JevAsker`; no test
contacts TypeSafe.

## Publish

```sh
npm run typecheck
npm pack --dry-run
```

Test the installed tarball, not just the linked copy, then
`opencode service restart` and exercise auto + manual compaction plus the
fallback path (unset key) before publishing.

## Layout

```
src/
  index.ts            # wiring only: Plugin.define + hook registration
  options.ts          # ctx.options narrowing (unknown → ResolvedPluginOptions)
  plugin-id.ts        # PLUGIN_ID = "jev.compaction"
  compaction/
    adapter.ts        # OpenCode Message → library Message (1:1, indexed)
    hook.ts           # session "compaction" hook (Effect, never throws)
    render.ts         # pruned transcript → summary string
  jev/
    client.ts         # JevClient (fetch-injected) + toEffectAsker/makeAsker
  lib/                # verbatim algorithm port (pure, promise-based core)
    jev-types.ts jev-state.ts jev-request.ts jev-compact.ts
tests/jev-compaction.test.ts
docs/adaptation.md
```

Guides: `EFFECT_PLUGIN_GUIDE.md` (OpenCode API reference),
`PLUGIN_MAINTENANCE_GUIDE.md` (the process rules this repo follows).
