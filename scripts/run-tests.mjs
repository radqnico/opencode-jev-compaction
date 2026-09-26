// Copies .ts sources to a temp dir rewriting .js->.ts imports, then runs
// node --test. Needed because Node's type stripping cannot resolve the
// repo's `.js`-suffix runtime imports (see docs/adaptation.md).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"

const root = process.cwd()
const tmp = join(tmpdir(), `jev-test-${Date.now()}`)
mkdirSync(tmp, { recursive: true })

function walk(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src)) {
    const s = join(src, e)
    const d = join(dst, e)
    if (statSync(s).isDirectory()) walk(s, d)
    else if (e.endsWith(".ts")) {
      const content = readFileSync(s, "utf8").replace(/\.js"/g, '.ts"')
      writeFileSync(d, content)
    }
  }
}
walk(join(root, "src"), join(tmp, "src"))
walk(join(root, "tests"), join(tmp, "tests"))
// link node_modules for effect/@opencode imports
execSync(`ln -s ${root}/node_modules ${tmp}/node_modules`)
execSync(`node --test ${tmp}/tests/jev-compaction.test.ts`, { stdio: "inherit" })
