#!/usr/bin/env bun
/**
 * CI entry point.
 *
 * The same self-test is exposed as `/orchestra-selftest` inside OpenCode, but CI
 * has no host to load the plugin into, so this calls the pure resolver directly
 * and turns the result into an exit code.
 *
 * The entry point is imported as well, which proves the whole module graph
 * parses and resolves. The resolver fixtures alone do not do that: they reach
 * `roles`, `context`, `fanout`, `evidence` and `loop-guard`, but not `agents`,
 * `pin`, `prompts`, `report` or `quarantine`.
 */
import plugin from "../index"
import { runSelfTest } from "../src/selftest"

let failed = 0

const entry = plugin as { id?: unknown; setup?: unknown }
if (typeof entry.id !== "string" || typeof entry.setup !== "function") {
  console.error(`FAIL plugin entry: expected { id, setup }, got keys ${JSON.stringify(Object.keys(entry))}`)
  failed++
} else {
  console.log(`ok   plugin entry: exports { id: "${entry.id}", setup }`)
}

const result = await runSelfTest()
for (const line of result.lines) console.log(line)
failed += result.failed

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
