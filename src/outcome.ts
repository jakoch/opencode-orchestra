/**
 * One vocabulary for a delegated turn's outcome.
 *
 * `delegate.ts` and `receipts.ts` each spelled the same lifecycle differently —
 * `ok: boolean` in one, `uncertain | delivered | failed` in the other — so
 * answering "did the advisor answer?" meant reading two mappings and reconciling
 * them. This is that lifecycle, once.
 *
 * **Scope: delegated turns only.** Two neighbouring vocabularies look mergeable
 * and are not, and conflating them would be the category error this module
 * exists to prevent:
 *
 * - `ProbeVerdict` (`ok | refused | unverified`) asks whether a *model* is usable
 *   from here. It is reachability, not an outcome: a provider that replies with
 *   an empty body has answered the only question the probe asks, and calling
 *   that `delivered` would claim an answer it never produced.
 * - `RoleAssignment.verification` (`verified | refused | unknown`) is that probe
 *   verdict under another name, kept where the report reads it.
 * - `ClaimSupport` is support strength — how well an assertion is backed — which
 *   has no outcome to be a view of.
 * - `CircuitVerdict` is a guard state, not a task result.
 */

import type { ErrorLike, FailureClass } from './failure'
import { classify } from './failure'

/**
 * What became of a delegated turn.
 *
 * `refused` and `failed` are the distinction that matters and had no name before.
 * A refusal is the provider declining — a credential, or a model that is gone —
 * and the work was never judged. A failure is the request being served and
 * producing nothing, which does say something about the task. A receipt that
 * recorded a credential refusal as `failed` told the builder the scout had found
 * nothing, when the truth is that the model was never asked.
 */
export type OutcomeStatus = 'delivered' | 'refused' | 'uncertain' | 'failed'

export interface Outcome {
  status: OutcomeStatus
  /** The answer when delivered; otherwise the reason it did not come back. */
  summary: string
  elapsedMs: number
  /**
   * Which refusal, when `status` is `refused`.
   *
   * The coarse status says an answer did not arrive; this says why, and the two
   * remediate differently — a credential refusal wants a pin, a withdrawn model
   * wants a different pin. Carried rather than folded into the status because
   * `refused` has to stay a small, readable set of words.
   */
  cause?: FailureClass
  /** Refs the dispatch walked, in order. More than one means a fallback fired. */
  tried?: string[]
}

/** The failure classes that mean nobody ever judged the work. */
const NOT_SERVED: readonly FailureClass[] = ['withdrawn', 'rejected']

/** The ones that mean we never found out, so the turn may yet succeed. */
const UNKNOWN: readonly FailureClass[] = ['transport', 'interrupted', 'rate_limited', 'unavailable']

export function outcomeFor(error: ErrorLike | string | undefined): { status: OutcomeStatus; cause: FailureClass } {
  const cause = classify(error)
  if (NOT_SERVED.includes(cause)) return { status: 'refused', cause }
  // A rate limit is not a verdict on the work. Recording it as a failure told
  // the builder the role had found nothing, which is exactly what a later retry
  // would contradict.
  if (UNKNOWN.includes(cause)) return { status: 'uncertain', cause }
  return { status: 'failed', cause }
}

/** True when the turn produced an answer the caller can act on. */
export function isDelivered(status: OutcomeStatus): boolean {
  return status === 'delivered'
}

/**
 * Not derivable from this, deliberately: `isWorthRetrying` in `failure.ts`
 * decides whether to walk to another *model*, which is a routing policy, while
 * `uncertain` says the work was never judged, which is a fact about the turn.
 * They disagree on purpose — a rate limit is uncertain and not worth retrying,
 * since the next candidate is usually the same provider on the same key.
 * `tests/failure-classes.test.ts` pins that disagreement against a real corpus.
 */
