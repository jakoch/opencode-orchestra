/**
 * Runs the in-host self-test as a `bun test` case.
 *
 * `src/selftest.ts` is the fixture suite exposed to OpenCode as
 * `/orchestra-selftest`, and it was previously invoked from
 * `scripts/run-tests.ts`. This keeps it in the default `bun test` run so
 * dropping that script from CI cannot silently stop the resolver being checked.
 */

import { expect, test } from 'bun:test'
import { runSelfTest } from '../src/selftest'

test('every resolver and signal fixture passes', async () => {
  const result = await runSelfTest()

  // The self-test reports by string, not by throw, so the lines are the only
  // diagnostic available when a fixture regresses.
  if (result.failed) console.error(result.lines.join('\n'))

  expect(result.passed).toBeGreaterThan(0)
  expect(result.failed).toBe(0)
})
