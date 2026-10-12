/**
 * Dispatch telemetry.
 *
 * The negative control matters more than the happy paths: a counter that
 * skipped first-candidate successes would have the same blind spot as the
 * `state.dispatches` log it replaced.
 */

import { describe, expect, test } from 'bun:test'
import { FanoutAdmission } from '../src/fanout'
import { DispatchTelemetry, describeTelemetry, GATE_DIMENSIONS } from '../src/telemetry'

const ok = { ok: true, elapsedMs: 100, candidates: 1 }
const fellBack = { ok: true, elapsedMs: 300, candidates: 2 }
const failed = { ok: false, elapsedMs: 50, candidates: 1 }

describe('dispatch counting', () => {
  test('a first-candidate success is counted, not just the awkward cases', () => {
    // The regression this whole package is about.
    const telemetry = new DispatchTelemetry()
    telemetry.recordDispatch('scout', ok)
    expect(telemetry.role('scout')?.attempts).toBe(1)
    expect(telemetry.role('scout')?.ok).toBe(1)
  })

  test('a fallback moves the counter', () => {
    const telemetry = new DispatchTelemetry()
    telemetry.recordDispatch('advisor', fellBack)
    const tally = telemetry.role('advisor')
    expect(tally?.attempts).toBe(1)
    expect(tally?.fellBack).toBe(1)
  })

  test('a failure is counted as a failure, not as a fallback', () => {
    const telemetry = new DispatchTelemetry()
    telemetry.recordDispatch('skeptic', failed)
    expect(telemetry.role('skeptic')?.failed).toBe(1)
    // One candidate was tried and it failed: no second model ran.
    expect(telemetry.role('skeptic')?.fellBack).toBe(0)
  })

  test('roles are tallied apart', () => {
    const telemetry = new DispatchTelemetry()
    telemetry.recordDispatch('scout', ok)
    telemetry.recordDispatch('advisor', failed)
    expect(telemetry.role('scout')?.attempts).toBe(1)
    expect(telemetry.role('advisor')?.attempts).toBe(1)
    expect(telemetry.role('builder')).toBeUndefined()
  })

  test('the sample window is bounded, oldest dropped first', () => {
    const telemetry = new DispatchTelemetry()
    for (let index = 0; index < 200; index++) telemetry.recordDispatch('scout', { ...ok, elapsedMs: index })
    const samples = telemetry.role('scout')!.samples
    // Bounded: an unbounded ring would grow for the life of the session.
    expect(samples.length).toBeLessThanOrEqual(64)
    // Oldest first, so the retained window is the most recent one.
    expect(samples.at(-1)).toBe(199)
  })

  test('a role tally is a copy, so a caller cannot inflate the count', () => {
    const telemetry = new DispatchTelemetry()
    telemetry.recordDispatch('scout', ok)
    telemetry.role('scout')!.attempts = 999
    expect(telemetry.role('scout')?.attempts).toBe(1)
  })
})

describe('gate refusals', () => {
  test('counted per dimension, so an unused gate shows zero', () => {
    const telemetry = new DispatchTelemetry()
    telemetry.recordGateRefusal('session')
    telemetry.recordGateRefusal('session')
    telemetry.recordGateRefusal('provider')
    expect(telemetry.snapshot().gates).toEqual({ session: 2, model: 0, provider: 1 })
  })

  test('every dimension is reported, so a zero is a fact rather than an absence', () => {
    const telemetry = new DispatchTelemetry()
    expect(Object.keys(telemetry.snapshot().gates).sort()).toEqual([...GATE_DIMENSIONS].sort())
  })

  test('a refusal carries its dimension on the error, not only in the prose', async () => {
    // The gate must not force a caller to recover the dimension by matching the
    // message: a reworded refusal string would silently zero the counter.
    const admission = new FanoutAdmission({ limit: 1, acquireTimeoutMs: 20 })
    const call = (id: string) => ({ id, sessionID: 's1', tool: 'subagent', input: {} })
    await admission.admit(call('a'))
    try {
      await admission.admit(call('b'))
      throw new Error('expected the second launch to be refused')
    } catch (error) {
      expect((error as { fanoutDimension?: string }).fanoutDimension).toBe('session')
    }
  })

  test('the refusal message the model reads is unchanged', async () => {
    const admission = new FanoutAdmission({ limit: 1, acquireTimeoutMs: 20 })
    const call = (id: string) => ({ id, sessionID: 's1', tool: 'subagent', input: {} })
    await admission.admit(call('a'))
    await expect(admission.admit(call('b'))).rejects.toThrow(/concurren|busy/i)
  })
})

describe('cost centres', () => {
  test('a probe is counted apart from a panel turn', () => {
    // A probe is one cheap request; a panel turn is a full delegated session.
    // Counting them as one number would hide which one costs.
    const telemetry = new DispatchTelemetry()
    telemetry.recordProbe(4)
    telemetry.recordPanel(2)
    const snapshot = telemetry.snapshot()
    expect(snapshot.probes).toBe(1)
    expect(snapshot.probed).toBe(4)
    expect(snapshot.panels).toBe(1)
    expect(snapshot.panelReviewers).toBe(2)
  })
})

describe('compaction', () => {
  test('a compaction that loses nothing is still counted', () => {
    // The whole point of the counter. `reopen` returns 0 on a compaction that
    // re-opened nothing, and if only the successes were recorded this would be
    // indistinguishable from a hook that never fires — leaving the question
    // "are receipts ever lost to compaction?" unanswerable in the one case
    // that would justify deleting persistence.
    const telemetry = new DispatchTelemetry()
    telemetry.recordCompaction(0)
    telemetry.recordCompaction(3)
    const snapshot = telemetry.snapshot()
    expect(snapshot.compactions).toBe(2)
    expect(snapshot.reopened).toBe(3)
  })

  test('the count is rendered, including the zero', () => {
    const lost = new DispatchTelemetry()
    lost.recordCompaction(2)
    expect(describeTelemetry(lost.snapshot()).join('\n')).toContain('2 re-opened across 1 compaction')

    // Stated in words rather than left to arithmetic: a reader seeing "0
    // re-opened" should not have to work out whether it means none were lost.
    const kept = new DispatchTelemetry()
    kept.recordCompaction(0)
    expect(describeTelemetry(kept.snapshot()).join('\n')).toContain('none were lost to compaction')
  })

  test('a re-opened count keeps the section alive on its own', () => {
    // No dispatch, no probe, no gate refusal — a session that only compacted.
    // If this returned empty there would be no figure to read at all.
    const telemetry = new DispatchTelemetry()
    expect(telemetry.isEmpty()).toBe(true)
    telemetry.recordCompaction(0)
    expect(telemetry.isEmpty()).toBe(false)
  })
})

describe('emptiness', () => {
  test('a session with no activity renders nothing', () => {
    // Otherwise every verbose report carries an empty measurement section.
    const telemetry = new DispatchTelemetry()
    expect(telemetry.isEmpty()).toBe(true)
    expect(describeTelemetry(telemetry.snapshot())).toEqual([])
  })

  test('any recorded activity makes it non-empty', () => {
    const gate = new DispatchTelemetry()
    gate.recordGateRefusal('model')
    expect(gate.isEmpty()).toBe(false)
  })
})

describe('rendering', () => {
  test('counts, latencies and refusals all reach the output', () => {
    const telemetry = new DispatchTelemetry()
    telemetry.recordDispatch('advisor', ok)
    telemetry.recordDispatch('advisor', fellBack)
    telemetry.recordGateRefusal('provider')
    telemetry.recordPanel(2)

    const text = describeTelemetry(telemetry.snapshot()).join('\n')
    expect(text).toContain('advisor')
    expect(text).toContain('provider 1')
    expect(text).toContain('Panels: 1')
    // Stated as a window, because the ring drops old samples and an unlabelled
    // 64-sample figure reads as a lifetime average.
    expect(text).toContain('not all of them')
  })

  test('evidence is summarised, not counted twice', () => {
    const lines = describeTelemetry(telemetrySnapshot(), {
      verificationRuns: 3,
      unverifiedFiles: 2,
      claims: { observed: 1, referenced: 2, unbacked: 1 }
    })
    const text = lines.join('\n')
    expect(text).toContain('3 verification run(s)')
    expect(text).toContain('2 file(s) unverified')
    expect(text).toContain('claims 3 backed / 1 unbacked')
  })

  test('a clean session still reports its verification runs', () => {
    // Nothing unbacked is the good case, and it is the one most likely to be
    // dropped by a "only if there is something wrong" guard.
    const text = describeTelemetry(new DispatchTelemetry().snapshot(), {
      verificationRuns: 1,
      unverifiedFiles: 0,
      claims: { observed: 1, referenced: 0, unbacked: 0 }
    }).join('\n')
    expect(text).toContain('1 verification run(s)')
  })
})

function telemetrySnapshot() {
  const telemetry = new DispatchTelemetry()
  telemetry.recordDispatch('scout', ok)
  return telemetry.snapshot()
}
