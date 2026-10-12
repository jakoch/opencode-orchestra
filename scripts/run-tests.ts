#!/usr/bin/env bun
/**
 * CI entry point. Runs the test suite and validates the plugin entry contract.
 * Uses process.execPath (not bare "bun") so CI uses the same runtime as this script.
 */
import plugin from '../index'

let failed = 0

const entry = plugin as { id?: unknown; setup?: unknown }
if (typeof entry.id !== 'string' || typeof entry.setup !== 'function') {
  console.error(`FAIL plugin entry: expected { id, setup }, got keys ${JSON.stringify(Object.keys(entry))}`)
  failed++
} else {
  console.log(`ok   plugin entry: exports { id: "${entry.id}", setup }`)
}

const suite = Bun.spawnSync([process.execPath, 'test', ...process.argv.slice(2)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['inherit', 'inherit', 'inherit']
})
if (suite.exitCode !== 0) failed++

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
