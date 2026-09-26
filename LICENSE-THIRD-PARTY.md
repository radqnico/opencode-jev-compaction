This project contains code ported from `tamaratran/fast-jev-compaction`
(https://github.com/tamaratran/fast-jev-compaction), which is MIT licensed,
Copyright (c) 2025 tamaratran.

Ported files and their upstream originals:

- `src/lib/jev-types.ts` ← upstream `src/types.ts`
- `src/lib/jev-state.ts` ← upstream `src/state.ts`
- `src/lib/jev-request.ts` ← upstream `src/request.ts`
- `src/lib/jev-compact.ts` ← upstream `src/compact.ts`
- `src/jev/client.ts` ← upstream `src/client.ts` (adapted: lazy API-key
  resolution, Effect wrapper `toEffectAsker`/`makeAsker` added)
- `tests/jev-compaction.test.ts` ← upstream `tests/fast-jev-compaction.test.ts`
  (adapted: `node:test` + `node:assert/strict` instead of vitest; plugin
  options, adapter, and render suites added)
- Fallback semantics (`minReductionRatio`, error → built-in summary) ←
  upstream `hooks/fast-jev.ts`

Deliberate adaptations (behavior-preserving unless noted):

- Style: double quotes, no semicolons (repo convention); `readonly`
  modifiers added per the maintenance guide.
- `truncatedResultText` note renamed from `[fast-jev-compaction truncated …]`
  to `[opencode-jev-compaction truncated …]`.
- Upstream `src/messages.ts` (`compactMessages` wrapper) not ported — the
  OpenCode hook in `src/compaction/hook.ts` is the only entrypoint.
- Upstream `hooks/fast-jev.ts` (Claude Code function hooks) not ported —
  replaced by `src/compaction/` (`adapter.ts`, `hook.ts`, `render.ts`)
  for OpenCode's `session "compaction"` hook, whose contract differs:
  it accepts only `event.result = { summary }`, not a message list
  (see `docs/adaptation.md`).
- Upstream `turn.complete` auto-compact hook not ported — OpenCode
  auto-compacts natively via `compaction.auto`.
- Upstream SwiftUI demo, marketplace files, and Claude Code type reference
  (`types/claude-code.d.ts`) not ported — plugin only, per scope.

Upstream license text:

```
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
