/**
 * Failure quarantine: the catalog is not the truth, so this remembers what actually failed. It
 * classifies model lifetime, not fault ownership (verification boundary: `docs/roles.md`), so a
 * terminal failure blocks at once, a rate limit only after several, a rejection never.
 */

/**
 * Failure quarantine: the catalog is not the truth, so this remembers what actually failed. It
 * classifies model lifetime, not fault ownership (verification boundary: `docs/roles.md`), so a
 * terminal failure blocks at once, a rate limit only after several, a rejection never.
 *
 * Classification lives in `src/failure.ts`; this module is the action policy.
 * They are separate because the other two callers disagree about what a rate
 * limit means, and collapsing that disagreement is what put three live bugs in
 * the six tables this replaced.
 */

import { classify, isCredentialRefusal as isRefusal, isWorthRetrying } from './failure'

export interface FailureRecord {
  /** `provider/model`. */
  ref: string
  reason: string
  occurrences: number
  firstSeen: number
  lastSeen: number
  /** Set once the record should keep the model out of detection. */
  blocked?: boolean
  /** Absent on records written before rejections existed. */
  kind?: Exclude<FailureKind, 'ignore'>
}

export type FailureKind = 'terminal' | 'soft' | 'rejected' | 'ignore'

/** Soft failures (rate limiting) before the model is blocked. */
export const SOFT_FAILURE_THRESHOLD = 3

/**
 * This module's action policy: what a failure means for a model's place in the
 * catalog.
 *
 * Only `withdrawn`, `rejected` and `rate_limited` say anything about the model.
 * A connection fault, a timeout, a user cancellation and a service outage are
 * all `ignore` here — none of them is evidence that this model is the problem,
 * and recording one as if it were is how a working model ends up quarantined by
 * a flaky network. `probe.ts` answers `unverified` to the same four, and
 * `receipts.ts` calls two of them unclear; those are separate policies over one
 * classification, which is the point.
 */
export function classifyFailure(error: { type?: string; message?: string; status?: number }): FailureKind {
  switch (classify(error)) {
    case 'withdrawn':
      return 'terminal'
    case 'rejected':
      return 'rejected'
    case 'rate_limited':
      return 'soft'
    default:
      return 'ignore'
  }
}

/**
 * A refusal naming the credential rather than the model. The host's own subagent launch creates a
 * child session, and a free tier refuses one while answering an ordinary session on the same model,
 * so this must never be charged to a model.
 */
export function isCredentialRefusal(error: { type?: string; message?: string } | string | undefined): boolean {
  return isRefusal(error)
}

/**
 * Whether the chain advances past a failure. Narrow on purpose, because callers
 * gate a retry on this: a false positive re-runs real work and cannot be undone,
 * while a false negative only leaves a dead model in place until the next
 * re-resolve. The rule itself is `isWorthRetrying`; this is the name this
 * module's callers already import.
 */
export function looksLikeTransportFault(
  error: { type?: string; message?: string; status?: number } | string | undefined
): boolean {
  return isWorthRetrying(error)
}

/** Folds a failure into the existing records and returns the updated store. */
export function recordFailure(
  records: Record<string, FailureRecord>,
  ref: string,
  error: { type?: string; message?: string; status?: number },
  now: number
): { records: Record<string, FailureRecord>; changed: boolean; kind: FailureKind } {
  const kind = classifyFailure(error)
  if (kind === 'ignore' || !ref) return { records, changed: false, kind }

  const previous = records[ref]
  const occurrences = (previous?.occurrences ?? 0) + 1
  // A block is sticky: a rejection arriving after a block must not quietly hand a model already
  // known dead back to detection, which is what "rejections never block" could otherwise introduce.
  const blocked =
    previous?.blocked === true || kind === 'terminal' || (kind === 'soft' && occurrences >= SOFT_FAILURE_THRESHOLD)
  const next: FailureRecord = {
    ref,
    reason: (error.message ?? error.type ?? 'provider failure').slice(0, 200),
    occurrences,
    firstSeen: previous?.firstSeen ?? now,
    lastSeen: now,
    blocked,
    kind
  }
  return {
    records: { ...records, [ref]: next },
    // Only a newly blocked model forces a re-detection. A rejection is recorded but never re-detects:
    // the point is to explain the failure, not to hide the model from a resolver that may be right.
    changed: blocked && !previous?.blocked,
    kind
  }
}

/**
 * Models detection must skip. Rejected-only models are absent by design: a refusal from this host
 * says nothing about the model working in the TUI, so they stay in the running and are reported
 * by `describeRejections`.
 */
export function blockedRefs(records: Record<string, FailureRecord>): string[] {
  return Object.values(records)
    .filter(record => record.blocked)
    .map(record => record.ref)
}

/**
 * Models this host is refused, as opposed to ones that are gone. The counterpart to `blockedRefs`
 * for consumers that cannot use the model but must not pretend it is dead: detection deliberately
 * still sees these, while a dispatch skips them because every plugin-driven request fails.
 */
export function rejectedRefs(records: Record<string, FailureRecord>): string[] {
  return Object.values(records)
    .filter(record => record.kind === 'rejected' && !record.blocked)
    .map(record => record.ref)
}

export function describeQuarantine(records: Record<string, FailureRecord>): string[] {
  return Object.values(records)
    .filter(record => record.blocked)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(record => `\`${record.ref}\` excluded after ${record.occurrences} failure(s): ${record.reason}`)
}

/**
 * Reported rather than excluded, so the report can say "this is why scout kept failing" without
 * taking the choice of pinning something else away from the human.
 */
export function describeRejections(records: Record<string, FailureRecord>): string[] {
  return Object.values(records)
    .filter(record => !record.blocked && record.kind === 'rejected')
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(
      record =>
        `\`${record.ref}\` refused ${record.occurrences} request(s) from outside the host app, so it stays in detection: ${record.reason}`
    )
}

export function pruneRecords(records: Record<string, FailureRecord>, olderThan: number): Record<string, FailureRecord> {
  const kept: Record<string, FailureRecord> = {}
  for (const [ref, record] of Object.entries(records)) {
    if (record.lastSeen >= olderThan) kept[ref] = record
  }
  return kept
}
