# opencode-jev-compaction

An OpenCode plugin that compacts sessions by pruning with TypeSafe Jev
instead of summarizing with an LLM. Tool calls Jev no longer considers
relevant are dropped or truncated; everything kept is preserved verbatim.

## Inspiration

This project ports
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(a Claude Code plugin, MIT) to OpenCode. The pruning algorithm, state
fitting, and fallback policy are taken from it verbatim; the host
integration is rewritten for OpenCode's `compaction` hook. Details of what
was kept and what had to change are in `docs/adaptation.md`, and the
upstream license is attributed in `LICENSE-THIRD-PARTY.md`.

## Quick install with an agent

Paste the following into any OpenCode session. The agent reads this
repository, installs the plugin, and verifies the setup:

```text
Install the OpenCode plugin from https://github.com/radqnico/opencode-jev-compaction:
1. Install it with `opencode plugin add github:radqnico/opencode-jev-compaction`.
2. export TYPESAFE_API_KEY="..."
3. Restart the OpenCode service and run `opencode plugin list` to confirm the plugin is loaded.
```

## Why

The default compaction asks a model to summarize the session. Summaries
lose information: a file path, an exact error, a constraint stated three
turns ago, or the command that produced a result can disappear even when
the next step depends on them.

This plugin takes a different approach. It sends the transcript to Jev
with the tool outputs replaced by size notes and asks, per tool call,
whether the call and its output are still needed. Calls that are not
needed are removed; outputs that are not needed verbatim are truncated to
a head plus a note saying the tool can be re-run. User and assistant text
is never edited, reordered, or shortened.

If Jev is unavailable, fails, or cannot achieve a worthwhile reduction,
the plugin declines and OpenCode falls back to its built-in summary. A
compaction therefore either preserves content exactly or behaves as if
the plugin were not installed.

## How it works

When OpenCode compacts a session, the plugin receives the transcript and
runs the following steps:

1. Convert OpenCode messages to the pruning model's transcript format.
   Text parts are concatenated verbatim; tool calls and results are
   paired by id; media, reasoning, and checkpoint parts are skipped.
2. Pin the first message and the newest N messages. Pinned content is
   never a candidate for removal.
3. Fit the transcript into the Jev state budget (tool outputs replaced
   by `ok, N chars (omitted)`), shrinking inputs, abridging long texts,
   and collapsing old messages in stages if needed.
4. Ask Jev two yes/no (`noul`) questions per unpinned call: does knowing
   the call was made still matter, and is the full output still needed
   verbatim. Questions are batched so state plus questions fit the
   request budget; the full state is resent with every batch.
5. Apply a threshold (default 0.5): above it on the output the call is
   kept; above it on the call only the output is truncated; below both
   the call and its output are removed.
6. Render the pruned transcript verbatim as the compaction summary,
   prefixed with a header recording the reduction, per-reason counts,
   and the per-call decisions.

OpenCode's hook accepts only a summary string, not a message list, so
the pruned transcript is stored as the compaction content rather than
replacing history. Later compactions treat it as prior summary text.

## Installation

One command installs the plugin from GitHub into the global OpenCode
configuration:

```sh
opencode plugin add github:radqnico/opencode-jev-compaction
```

Set the TypeSafe key once, in the shell profile or the environment
OpenCode runs in:

```sh
export TYPESAFE_API_KEY="..."
```

Restart the service and confirm the plugin loaded:

```sh
opencode service restart
opencode plugin list
```

## Manual setup

For a local checkout or for development, point a plugin entry at the
repository directory instead. OpenCode loads TypeScript sources
directly; no build step is needed:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/path/to/opencode-jev-compaction" }]
}
```

For development inside this repository, the auto-loaded shim at
`.opencode/plugins/jev-compaction/index.ts` re-exports `src/index.ts`,
so opening this directory in OpenCode loads the plugin with no config.

After changing the plugin, reload it:

```sh
touch .opencode/plugins/jev-compaction/index.ts
opencode service restart && opencode service status
```

## Configuration

All options go under the plugin entry in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-jev-compaction",
      "options": {
        "model": "jev-latest",
        "keepThreshold": 0.5,
        "minReductionRatio": 0.25
      }
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key. May be omitted when the endpoint needs no auth (gateway without auth, local mock). Never commit it. |
| `model` | `jev-latest` | Jev model name. Accepts version pins such as `jev-1.13.0`. |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | Custom System One endpoint (proxy, gateway, mock server). |
| `headers` | — | Extra HTTP headers merged into every Jev request, e.g. `{ "x-proxy-token": "..." }`. `authorization` and `content-type` cannot be overridden. Non-string values are ignored. |
| `goal` | last 3 user prompts | Task description included in the Jev state. |
| `keepThreshold` | `0.5` | Minimum keep probability. Below it on both questions the call is removed; below it on the output only the output is truncated. |
| `preserveRecentMessages` | `6` | Newest messages pinned from pruning. The first message is always pinned. |
| `maxStateTokens` | `25000` | Token ceiling for the Jev state, estimated without a tokenizer. |
| `maxRequestTokens` | `30000` | Ceiling for state plus one batch of questions. |
| `truncateHeadChars` | `300` | Characters of a dropped output retained before the truncation note. |
| `minReductionRatio` | `0.25` | Minimum estimated character reduction. Below it the plugin declines and OpenCode uses its built-in summary. |

## Development

```sh
npm run typecheck
npm test
```

Tests use `node:test` and `node:assert/strict`. The Jev network boundary
is a fake asker; no test contacts TypeSafe. Live verification against the
real API is done ad hoc with a script that reads the key from
`TYPESAFE_API_KEY` and checks the model list, a minimal judgment, a full
`compact()` run, and the hook path end to end.
