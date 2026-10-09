/**
 * Failure quarantine.
 *
 * The catalog is not the truth. A model can be withdrawn upstream while still
 * being listed as active, and a rate limit is not the same as a model being
 * gone. Detection picks today's best; this remembers what actually failed so
 * tomorrow's pick is not the same dead endpoint.
 *
 * Policy: a terminal failure (deprecated, not found, unavailable) quarantines
 * immediately, because retrying cannot fix it. A rate limit is treated as a
 * symptom and only quarantines after several occurrences, because bursts are
 * normal and losing the model to one busy minute would be worse.
 */

export interface FailureRecord {
  /** `provider/model`. */
  ref: string
  reason: string
  occurrences: number
  firstSeen: number
  lastSeen: number
  /** Set once the record should keep the model out of detection. */
  blocked?: boolean
}

/** Occurrences of a soft failure (rate limiting) before the model is dropped. */
export const SOFT_FAILURE_THRESHOLD = 3

const TERMINAL_PATTERNS = [
  /deprecat/i,
  /not found/i,
  /no such model/i,
  /unknown model/i,
  /unavailable/i,
  /not available/i,
  /does not exist/i,
]

const SOFT_PATTERNS = [/rate limit/i, /too many requests/i, /\b429\b/, /quota/i]

export function classifyFailure(error: { type?: string; message?: string; status?: number }): "terminal" | "soft" | "ignore" {
  const haystack = `${error.type ?? ""} ${error.message ?? ""}`
  if (TERMINAL_PATTERNS.some((pattern) => pattern.test(haystack))) return "terminal"
  if (error.status === 404 || error.status === 410) return "terminal"
  if (SOFT_PATTERNS.some((pattern) => pattern.test(haystack)) || error.status === 429) return "soft"
  return "ignore"
}

/** Folds a failure into the existing records and returns the updated store. */
export function recordFailure(
  records: Record<string, FailureRecord>,
  ref: string,
  error: { type?: string; message?: string; status?: number },
  now: number,
): { records: Record<string, FailureRecord>; changed: boolean; kind: "terminal" | "soft" | "ignore" } {
  const kind = classifyFailure(error)
  if (kind === "ignore" || !ref) return { records, changed: false, kind }

  const previous = records[ref]
  const occurrences = (previous?.occurrences ?? 0) + 1
  const blocked = kind === "terminal" || occurrences >= SOFT_FAILURE_THRESHOLD
  const next: FailureRecord = {
    ref,
    reason: (error.message ?? error.type ?? "provider failure").slice(0, 200),
    occurrences,
    firstSeen: previous?.firstSeen ?? now,
    lastSeen: now,
    blocked,
  }
  return {
    records: { ...records, [ref]: next },
    // Only a newly blocked model forces a re-detection.
    changed: blocked && !previous?.blocked,
    kind,
  }
}

export function blockedRefs(records: Record<string, FailureRecord>): string[] {
  return Object.values(records)
    .filter((record) => record.blocked)
    .map((record) => record.ref)
}

/** Short, human-readable summary for the report. */
export function describeQuarantine(records: Record<string, FailureRecord>): string[] {
  return Object.values(records)
    .filter((record) => record.blocked)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((record) => `\`${record.ref}\` excluded after ${record.occurrences} failure(s): ${record.reason}`)
}

export function pruneRecords(records: Record<string, FailureRecord>, olderThan: number): Record<string, FailureRecord> {
  const kept: Record<string, FailureRecord> = {}
  for (const [ref, record] of Object.entries(records)) {
    if (record.lastSeen >= olderThan) kept[ref] = record
  }
  return kept
}