import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { registerCompactionHook } from "./compaction/index.js"
import { parseOptions } from "./options.js"
import { PLUGIN_ID } from "./plugin-id.js"

export default Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = parseOptions(ctx.options)
      yield* registerCompactionHook(ctx, options)
      yield* Effect.logInfo("plugin loaded", { id: PLUGIN_ID, version: ctx.app.version })
      yield* Effect.addFinalizer(() => Effect.logInfo("plugin unloaded", { id: PLUGIN_ID }))
    }),
})
