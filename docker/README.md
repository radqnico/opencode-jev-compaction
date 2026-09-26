# Docker harness

Clean-room test rig: fresh container, isolated `HOME`, pinned OpenCode
binary, plugin source mounted read-only. Nothing from the host leaks in
except the working tree.

## Layout

```
docker/
  Dockerfile    # node:22-bookworm-slim + pinned opencode binary + npm install
  compose.yml   # mounts src/tests/package.json read-only, isolated HOME
  entrypoint.sh # harness: install | unit | load | matrix | serve | run | all | shell
```

## Usage

```sh
# Full suite (default): fresh install + unit + load smoke + hook matrix
docker compose -f docker/compose.yml run --rm harness all

# Single stages
docker compose -f docker/compose.yml run --rm harness install
docker compose -f docker/compose.yml run --rm harness unit
docker compose -f docker/compose.yml run --rm harness load
docker compose -f docker/compose.yml run --rm harness matrix

# E2E incl. serve + session + compact endpoint reachability
docker compose -f docker/compose.yml run --rm harness run

# Interactive shell inside the clean room
docker compose -f docker/compose.yml run --rm harness shell

# Live Jev path (real API key, real network)
TYPESAFE_API_KEY=... docker compose -f docker/compose.yml run --rm harness run

# Pin a different OpenCode version
OPENCODE_VERSION=1.18.32 docker compose -f docker/compose.yml build
```

## What each stage proves

| Stage | Proves | Network |
| --- | --- | --- |
| `install` | Binary runs, deps install from scratch, `typecheck` clean | Yes (npm + GitHub release) |
| `unit` | 23 `node:test` suites pass (fake `JevAsker`, no network) | No |
| `load` | Project boots with plugin present, no crash | No |
| `matrix` | 9 hook robustness cases: missing key, HTTP 500, malformed JSON, fetch throw, unfittable history, below `minReductionRatio`, stubbed-Jev success + summary verbatim checks, custom-header merge, `baseUrl` override against a local echo server | No |
| `run` | All of the above + `serve` responds, session creates, compact endpoint reachable | Yes (localhost serve) |

## Known limits (honest)

- The image pins **opencode 1.18.32 (v1 fork)** from
  `anomalyco/opencode` releases — there is no v2 binary published there
  yet. The v1 binary **silently ignores v2 Effect plugins** (no "loading
  plugin" log line), so `load` is a boot smoke test, not a real load
  proof. The hook contract itself (`runJevCompaction`, fallback values,
  `renderSummary`) is covered by `matrix` against the installed
  `@opencode/plugin@2.0.18` types. When a v2 binary is published,
  switch the Dockerfile to it and promote `load` to assert
  `plugin loaded id=jev.compaction` in the log.
- The v1 `POST /api/session/:id/compact` answers
  `ServiceUnavailableError("Session compact is not available yet")` —
  endpoint reachability only, not hook execution.
- `TYPESAFE_API_KEY` is unset by default (fallback path). Set it to
  exercise the live Jev path end to end.
- The `.opencode/` tree is mounted read-only, which trips opencode's
  attempt to write `.opencode/.gitignore` (`FileSystem.writeFile` error
  in `install`). Environmental, not a plugin failure.
