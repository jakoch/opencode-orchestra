/**
 * Reading a usage window out of a trace.
 *
 * These tests exist because the failure they guard is invisible: a window
 * double-counted still prints a table of plausible numbers, and the person
 * reading it would have to catch the arithmetic themselves. Every case below is
 * a way the count could be wrong while looking right.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../plugin/index'
import type { PluginDefinitionLike } from '../src/plugin-types'
import { compactionVerdict, gatesCanBeJudged, summarise, type UsageWindow } from '../src/usage-window'
import type { PluginHarness } from './harness'
import { createPluginHarness, invocation } from './harness'

const entry = plugin as PluginDefinitionLike

const dir = mkdtempSync(join(tmpdir(), 'usage-window-'))
const tracePath = join(dir, 'trace.jsonl')
let harness: PluginHarness | undefined
let teardown: undefined | (() => void)

async function load(): Promise<PluginHarness> {
  const created = createPluginHarness({
    directory: dir,
    options: { debug: true, tracePath }
  })
  harness = created
  teardown = await entry.setup(created.ctx)
  return created
}

afterEach(async () => {
  if (typeof teardown === 'function') await teardown()
  await harness?.disposeAll()
  teardown = undefined
  harness = undefined
  rmSync(dir, { force: true, recursive: true })
})

/**
 * One telemetry line as the plugin writes it.
 *
 * `pid` is omitted rather than defaulted when a caller passes it as `undefined`,
 * so a test can express "a trace written before pid existed" rather than
 * accidentally producing a shared pid.
 */
const line = (over: Record<string, unknown> = {}) => {
  const { pid, ...rest } = { pid: 100, ...over }
  return JSON.stringify({
    event: 'telemetry',
    dispatches: 0,
    fellBack: 0,
    elapsedTotalMs: 0,
    gateRefusals: '0/0/0',
    compactions: 0,
    receiptsReopened: 0,
    probes: 0,
    panels: 0,
    ...(pid === undefined ? {} : { pid }),
    ...rest
  })
}

const window = (...lines: string[]): UsageWindow => summarise(lines.join('\n'))

describe('cumulative counters are not summed within a process', () => {
  test('three reports in one process count once', () => {
    // The bug this whole module guards. `/orchestra` writes a cumulative
    // snapshot, so a session with three reports contributes 1, 2 and 3 — and
    // summing them reads as 6 dispatches when 3 happened. Worse, the more
    // often a busy session reports, the more it is inflated.
    const result = window(
      line({ pid: 7, dispatches: 1 }),
      line({ pid: 7, dispatches: 2 }),
      line({ pid: 7, dispatches: 3 })
    )
    expect(result.runs).toHaveLength(1)
    expect(result.totals.dispatches).toBe(3)
  })

  test('separate processes are summed', () => {
    // The other half: those really are separate runs, and collapsing them would
    // under-report a window that did happen.
    const result = window(line({ pid: 1, dispatches: 5 }), line({ pid: 2, dispatches: 2 }))
    expect(result.runs).toHaveLength(2)
    expect(result.totals.dispatches).toBe(7)
  })

  test('two runs ending on identical totals stay separate', () => {
    // The reason a process id is needed at all. With no id the only available
    // grouping is the values themselves, and these two runs would merge into
    // one — halving a real window.
    const result = window(line({ pid: 1, dispatches: 4 }), line({ pid: 2, dispatches: 4 }))
    expect(result.runs).toHaveLength(2)
    expect(result.totals.dispatches).toBe(8)
  })

  test('a repeated identical report in one process is one run', () => {
    const result = window(line({ pid: 1, dispatches: 3 }), line({ pid: 1, dispatches: 3 }))
    expect(result.runs).toHaveLength(1)
    expect(result.totals.dispatches).toBe(3)
  })
})

describe('the window does not over- or under-count', () => {
  test('gate refusals add across runs and unpack per dimension', () => {
    const result = window(line({ pid: 1, gateRefusals: '3/1/0' }), line({ pid: 2, gateRefusals: '0/2/5' }))
    expect(result.totals.gates).toEqual({ session: 3, model: 3, provider: 5 })
  })

  test('a truncated final line is skipped, not fatal', () => {
    // Expected in practice: the trace writes synchronously and a full disk loses
    // the tail. Failing the whole read would discard the window with it.
    const result = window(line({ pid: 1, dispatches: 9 }), '{"event":"telemetry","pid":1,"dispa')
    expect(result.runs).toHaveLength(1)
    expect(result.totals.dispatches).toBe(9)
    expect(result.lines).toBe(2)
  })

  test('non-telemetry lines are ignored but still counted as lines', () => {
    // `lines` is how a reader tells "no activity recorded" from "no data at all",
    // which are opposite findings.
    const result = window(line({ pid: 1, dispatches: 2 }), line({ pid: 2, dispatches: 3 }))
    expect(result.lines).toBe(2)
    expect(result.totals.dispatches).toBe(5)
  })

  test('a pidless line counts as its own run rather than merging', () => {
    // An older trace has no pid. Coalescing those into one bucket would drop
    // real runs and read as evidence a mechanism was never used.
    const result = window(line({ pid: undefined, dispatches: 2 }), line({ pid: undefined, dispatches: 3 }))
    expect(result.runs).toHaveLength(2)
    expect(result.totals.dispatches).toBe(5)
  })

  test('counters missing from an older trace read as zero', () => {
    // `compactions` post-dates the trace format. Reading it as zero is the only
    // honest option, and `compactionVerdict` refuses to conclude from a zero it
    // cannot vouch for.
    const older = JSON.stringify({ event: 'telemetry', pid: 1, dispatches: 4, gateRefusals: '0/0/0' })
    const result = window(older)
    expect(result.totals.compactions).toBe(0)
    expect(result.totals.dispatches).toBe(4)
  })

  test('malformed numbers do not become NaN', () => {
    const result = window(line({ pid: 1, dispatches: 'nonsense', compactions: null }))
    expect(result.totals.dispatches).toBe(0)
    expect(result.totals.compactions).toBe(0)
  })

  test('an empty file is an empty window, not a crash', () => {
    const result = summarise('')
    expect(result.runs).toEqual([])
    expect(result.totals.dispatches).toBe(0)
  })
})

describe('what the plugin writes', () => {
  test('a written telemetry line carries the pid and the compaction counts', async () => {
    // The wiring, not the arithmetic. `summarise` is unit-tested over hand-made
    // lines, and what this catches is the plugin ceasing to *write* the fields
    // the reader depends on — a trace with no pid merges separate runs, and one
    // with no compaction count reports "no receipts were lost" for a window
    // that simply never recorded it.
    //
    // Read from the file the plugin actually wrote, not from its source: a
    // source match passes on a comment and breaks on a reformat.
    const created = await load()
    await created.settle()
    await created.runCommand('orchestra', invocation({ sessionID: 's1', prompt: { text: 'all' } }))
    await created.settle()

    const written = readFileSync(tracePath, 'utf8')
    const line = written
      .split('\n')
      .filter(Boolean)
      .map(row => JSON.parse(row) as Record<string, unknown>)
      .find(row => row.event === 'telemetry')

    expect(line).toBeDefined()
    expect(line?.pid).toBe(process.pid)
    // Zeros are still written: a field missing from the line reads as
    // unrecorded, and the reader cannot tell that from a mechanism unused.
    expect(line?.compactions).toBe(0)
    expect(line?.receiptsReopened).toBe(0)
    expect(line?.gateRefusals).toBe('0/0/0')

    // And the round trip: what the plugin wrote is what the reader reads back.
    expect(summarise(written).runs).toHaveLength(1)
  })
})

describe('a thin window cannot decide a gate', () => {
  // The bug this guards: a window with no launches reports zero refusals, which
  // reads exactly like "the gate is never needed" — and the rule is that a
  // gate at zero refusals earns deletion. Two situations produce identical
  // zeros: one session that hit the limit and one that never launched at all.
  // Only the first is evidence, so the second must not render a verdict.
  test('no launches means the gate section cannot conclude', () => {
    const idle = window(line({ pid: 1, dispatches: 0, gateRefusals: '0/0/0' }))
    expect(idle.totals.gates).toEqual({ session: 0, model: 0, provider: 0 })
    expect(gatesCanBeJudged(idle)).toBe(false)
  })

  test('a couple of launches is still too few to be a sample', () => {
    expect(gatesCanBeJudged(window(line({ pid: 1, dispatches: 2 })))).toBe(false)
  })

  test('a real sample can be judged', () => {
    expect(gatesCanBeJudged(window(line({ pid: 1, dispatches: 3 })))).toBe(true)
  })

  test('refusals themselves do not make a window thin', () => {
    // A single run that fired the gate has, by definition, something to report —
    // even if its dispatch count is low. The floor is about having been in a
    // position to fire, and a refusal proves it was.
    const fired = window(line({ pid: 1, dispatches: 1, gateRefusals: '4/0/0' }))
    expect(gatesCanBeJudged(fired)).toBe(false)
    expect(fired.totals.gates.session).toBe(4)
  })
})

describe('the compaction verdict refuses to over-claim', () => {
  test('no compactions is neither evidence for nor against persistence', () => {
    // The distinction that matters most, and the one a bare zero gets wrong:
    // "zero compactions happened" is not "zero receipts were lost".
    expect(compactionVerdict(window(line({ compactions: 0 })))).toMatch(/neither justified nor disproved/)
  })

  test('compactions that lost nothing is the case that would justify a cut', () => {
    expect(compactionVerdict(window(line({ compactions: 5, receiptsReopened: 0 })))).toMatch(/could be cut/)
  })

  test('a re-opened receipt means persistence is earning its place', () => {
    expect(compactionVerdict(window(line({ compactions: 2, receiptsReopened: 1 })))).toMatch(/doing real work/)
  })

  test('an empty window does not claim anything about persistence', () => {
    // A zero here means nothing was recorded, so it must not read as a result.
    expect(compactionVerdict(summarise(''))).toMatch(/neither justified nor disproved/)
  })
})
