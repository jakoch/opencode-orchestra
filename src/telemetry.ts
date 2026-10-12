/**
 * Dispatch telemetry.
 *
 * `state.dispatches` records a dispatch only when it failed or walked to a
 * second candidate, so the common case — a role that answered on the first
 * candidate — was invisible. This counts that too, which is what lets a gate's
 * existence be argued from how often it actually fires.
 *
 * Counters are aggregate and bounded, and nothing here throws: a counter that
 * could fail a delegation would be a new failure mode, not a measurement. No
 * host types, so it is testable without the harness.
 */

import type { RoleName } from './types'
import { ROLES } from './types'

/** The three admission dimensions `FanoutAdmission` gates on. */
export const GATE_DIMENSIONS = ['session', 'model', 'provider'] as const
export type GateDimension = (typeof GATE_DIMENSIONS)[number]

/**
 * Latency samples kept per role.
 *
 * Percentiles over every dispatch would grow without bound in a long session,
 * and an average hides exactly the tail that matters here — a dispatch that took
 * the whole `delegateTimeoutMs` is the one worth seeing. The window is old-samples-
 * dropped, so the number describes recent behaviour rather than all of it, and
 * that is stated wherever the figure is rendered.
 */
const LATENCY_WINDOW = 64

export interface RoleTally {
  attempts: number
  ok: number
  failed: number
  /** Dispatches whose walk reached a second candidate. */
  fellBack: number
  elapsedTotalMs: number
  /** Bounded, oldest dropped first. */
  samples: number[]
}

export interface DispatchOutcome {
  ok: boolean
  elapsedMs: number
  /** Candidates the walk tried. Above 1 means a fallback fired. */
  candidates: number
}

/** One session's verification state, read from `EvidenceStore` rather than copied. */
export interface EvidenceSummary {
  verificationRuns: number
  unverifiedFiles: number
  claims: { observed: number; referenced: number; unbacked: number }
}

export interface TelemetrySnapshot {
  roles: Partial<Record<RoleName, RoleTally>>
  /** Refusals per admission dimension, so an unused gate shows zero. */
  gates: Record<GateDimension, number>
  /** `probeAssignments` calls, and how many role models they asked about. */
  probes: number
  probed: number
  /** Delegated reviewer turns per `/panel` invocation. */
  panels: number
  panelReviewers: number
  /**
   * Consumed receipts re-opened by compaction, and how many compactions did it.
   *
   * The pair matters more than either half: a non-zero `reopened` over several
   * compactions means receipts are surviving a context loss, and a large gap
   * between the two means most compactions re-opened nothing — which is the
   * evidence a persistence cut would be argued from.
   */
  compactions: number
  reopened: number
}

function emptyTally(): RoleTally {
  return { attempts: 0, ok: 0, failed: 0, fellBack: 0, elapsedTotalMs: 0, samples: [] }
}

/** Percentile over a copy; the input order is never disturbed. */
function percentile(samples: readonly number[], fraction: number): number | undefined {
  if (!samples.length) return undefined
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

export class DispatchTelemetry {
  private readonly roles = new Map<RoleName, RoleTally>()
  private readonly gates: Record<GateDimension, number> = { session: 0, model: 0, provider: 0 }
  private probes = 0
  private probed = 0
  private panels = 0
  private panelReviewers = 0
  private compactions = 0
  private reopened = 0

  /**
   * One dispatch outcome, successful or not.
   *
   * Every dispatch, not only the awkward ones: a counter that skips the common
   * case cannot answer "how often does a role fall back".
   */
  recordDispatch(role: RoleName, outcome: DispatchOutcome): void {
    let tally = this.roles.get(role)
    if (!tally) {
      tally = emptyTally()
      this.roles.set(role, tally)
    }
    tally.attempts += 1
    if (outcome.ok) tally.ok += 1
    else tally.failed += 1
    if (outcome.candidates > 1) tally.fellBack += 1
    tally.elapsedTotalMs += outcome.elapsedMs
    tally.samples.push(outcome.elapsedMs)
    while (tally.samples.length > LATENCY_WINDOW) tally.samples.shift()
  }

  /** One admission refusal. `dimension` comes off the thrown error, never off its text. */
  recordGateRefusal(dimension: GateDimension): void {
    this.gates[dimension] += 1
  }

  /**
   * One `probeAssignments` run, over `models` role assignments.
   *
   * Tracked apart from panels: a probe is a cheap single-shot request and a
   * panel turn is a full delegated session, so counting them together would
   * hide which one costs.
   */
  recordProbe(models: number): void {
    this.probes += 1
    this.probed += Math.max(0, models)
  }

  /** One `/panel`, which delegates to `reviewers` roles concurrently. */
  recordPanel(reviewers: number): void {
    this.panels += 1
    this.panelReviewers += reviewers
  }

  /**
   * One compaction, and how many consumed receipts it put back.
   *
   * Recorded even when nothing is re-opened, because the zero is the datum: a
   * compaction that re-opens nothing is evidence, and counting only the
   * successes would leave that indistinguishable from a hook that never fires.
   */
  recordCompaction(reopened: number): void {
    this.compactions += 1
    this.reopened += Math.max(0, reopened)
  }

  role(role: RoleName): RoleTally | undefined {
    const tally = this.roles.get(role)
    return tally ? { ...tally, samples: [...tally.samples] } : undefined
  }

  snapshot(): TelemetrySnapshot {
    const roles: Partial<Record<RoleName, RoleTally>> = {}
    for (const role of ROLES) {
      const tally = this.roles.get(role)
      if (tally) roles[role] = { ...tally, samples: [...tally.samples] }
    }
    return {
      roles,
      gates: { ...this.gates },
      probes: this.probes,
      probed: this.probed,
      panels: this.panels,
      panelReviewers: this.panelReviewers,
      compactions: this.compactions,
      reopened: this.reopened
    }
  }

  /** True when nothing has been recorded, so the section can be omitted entirely. */
  isEmpty(): boolean {
    if (this.probes || this.probed || this.panels || this.panelReviewers) return false
    // A compaction that re-opened nothing still makes the section non-empty: the
    // zero is the measurement that would justify cutting receipt persistence.
    if (this.compactions || this.reopened) return false
    if (GATE_DIMENSIONS.some(dimension => this.gates[dimension] > 0)) return false
    return this.roles.size === 0
  }

  reset(): void {
    this.roles.clear()
    this.gates.session = 0
    this.gates.model = 0
    this.gates.provider = 0
    this.probes = 0
    this.probed = 0
    this.panels = 0
    this.panelReviewers = 0
    this.compactions = 0
    this.reopened = 0
  }
}

/**
 * The diagnostics block for `/orchestra`.
 *
 * Opt-in only: the default report answers "what is running and what is risky",
 * and measurement is a question about the plugin rather than the session.
 *
 * Percentiles are labelled as a recent window rather than an all-time figure,
 * because the sample ring drops old entries and saying so is cheaper than
 * letting someone read 64 samples as a lifetime average.
 */
export function describeTelemetry(snapshot: TelemetrySnapshot, evidence?: EvidenceSummary): string[] {
  const lines: string[] = []
  const rows = ROLES.filter(role => snapshot.roles[role])
  if (rows.length) {
    lines.push('| Role | Dispatches | Ok | Failed | Fell back | p50 | p95 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const role of rows) {
      const tally = snapshot.roles[role]!
      const p50 = percentile(tally.samples, 0.5)
      const p95 = percentile(tally.samples, 0.95)
      lines.push(
        `| ${role} | ${tally.attempts} | ${tally.ok} | ${tally.failed} | ${tally.fellBack} | ` +
          `${p50 === undefined ? '-' : `${p50}ms`} | ${p95 === undefined ? '-' : `${p95}ms`} |`
      )
    }
    lines.push('')
    lines.push(`Latency is over the last ${LATENCY_WINDOW} dispatches per role, not all of them.`)
  }

  const refused = GATE_DIMENSIONS.filter(dimension => snapshot.gates[dimension] > 0)
  if (refused.length) {
    lines.push(
      `Admission refusals: ${refused.map(dimension => `${dimension} ${snapshot.gates[dimension]}`).join(', ')}.`
    )
  }

  if (snapshot.compactions) {
    // Rendered even at zero reopens, and says so in words: a reader who sees
    // "0 re-opened" learns something different from a line that is absent
    // because the hook never fired.
    lines.push(
      `Receipts: ${snapshot.reopened} re-opened across ${snapshot.compactions} compaction(s)` +
        `${snapshot.reopened ? '.' : ' — none were lost to compaction.'}`
    )
  }

  if (snapshot.probes || snapshot.panels || snapshot.panelReviewers) {
    lines.push(
      `Probes: ${snapshot.probes} run(s) over ${snapshot.probed} role model(s). ` +
        `Panels: ${snapshot.panels}, running ${snapshot.panelReviewers} reviewer turn(s) in total.`
    )
  }

  if (evidence) {
    const parts = [`${evidence.verificationRuns} verification run(s)`]
    if (evidence.unverifiedFiles) parts.push(`${evidence.unverifiedFiles} file(s) unverified`)
    const backed = evidence.claims.observed + evidence.claims.referenced
    if (backed || evidence.claims.unbacked) {
      parts.push(`claims ${backed} backed / ${evidence.claims.unbacked} unbacked`)
    }
    lines.push(`This session: ${parts.join(', ')}.`)
  }

  return lines
}
