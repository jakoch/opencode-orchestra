/**
 * One classifier for every failure the plugin sees.
 * This module decides *what kind of failure this is*; each caller decides what to do about it
 * because they genuinely disagree: a rate limit means retry elsewhere for a dispatch, wait for a probe, nothing for a receipt.
 * One table per class, and the only place a phrase may be added. A missed refusal phrasing disables the reroute outright.
 */

/** What kind of failure this is. Not what anyone should do about it. */
export const FAILURE_CLASSES = [
  /** The model is gone: deprecated, retired, withdrawn, or never existed. */
  'withdrawn',
  /** The credential was refused — free tier, or a host restriction. */
  'rejected',
  /** Rate limiting. The model may well be fine. */
  'rate_limited',
  /** Connection never completed: refused, reset, timed out, or a bad proxy. */
  'transport',
  /** A turn that was cut short rather than refused. */
  'interrupted',
  /** The service is having a bad time. The model is not implicated. */
  'unavailable',
  /** Unrecognised. Says nothing about the model. */
  'task'
] as const

export type FailureClass = (typeof FAILURE_CLASSES)[number]

/**
 * One table per class, and this is the only place a phrase may be added.
 * Ordered as the union is, because classes overlap in prose: "service unavailable" is a service problem,
 * while "Model is unavailable" is a withdrawn model — only the noun tells them apart.
 * Model-lifetime patterns require a subject rather than matching the bare word.
 */
const WITHDRAWN_PATTERNS = [
  /deprecat/i,
  /\b(?:retired|withdrawn|discontinued)\b/i,
  /no such model/i,
  /unknown model/i,
  /model[_ -]?not[_ -]?found/i,
  // Subject-qualified, so `service unavailable` below does not match.
  /\bmodels?\b[^\n]{0,60}\b(?:removed|no longer|does not exist|not found|not available|unavailable)\b/i,
  /\bendpoint\b[^\n]{0,40}\bunavailable\b/i,
  /not available/i,
  /does not exist/i
]

/**
 * Credential refusals.
 * Two patterns because the provider does not phrase this consistently: both
 * `can only be used from within OpenCode` and `must be used from within
 * opencode` have been seen. `probe.ts` previously carried only the `can`
 * phrasing, which is why it read half of these as terminal.
 */
const REJECTED_PATTERNS = [
  /(?:can|must) only? be used (?:from |only )?(?:within|by|inside) (?:the )?opencode/i,
  /(?:free tier|free plan|this model|the model|credential).{0,40}?(?:can|must) (?:only )?be used/i
]

const RATE_LIMITED_PATTERNS = [/rate limit/i, /too many requests/i, /\b429\b/, /quota/i]

/** Connection never completed. Distinct from `interrupted`, which is a turn cut short. */
const TRANSPORT_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /fetch failed/i,
  /proxy error/i
]

/**
 * A turn that stopped rather than being refused.
 * `timeout` as well as `timed out`, so `gateway timeout` lands here rather than
 * in `unavailable`: both are service-side and both report as unverified, and
 * a receipt must call both of them unclear.
 */
const INTERRUPTED_PATTERNS = [
  /\btimed?\s*out\b/i,
  /\btimeout\b/i,
  /\bdeadline exceeded\b/i,
  /\betimedout\b/i,
  /\b(?:aborted?|cancell?ed|interrupted?|enotify)\b/i,
  /\bstream (?:closed|ended)\b/i,
  /\bsession (?:closed|ended|removed)\b/i,
  /\bconnection (?:closed|aborted)\b/i
]

/** The service is degraded. Never a verdict on the model. */
const UNAVAILABLE_PATTERNS = [
  /service unavailable/i,
  /bad gateway/i,
  /server error/i,
  /internal error/i,
  /\boverloaded\b/i,
  /\b(?:too slow|slow down)\b/i
]

export interface ErrorLike {
  type?: string
  message?: string
  status?: number
}

function text(error: ErrorLike | string | undefined): string {
  if (typeof error === 'string') return error
  if (!error) return ''
  return `${error.type ?? ''} ${error.message ?? ''}`
}

/**
 * The one classification. Never throws, never returns `undefined`: an
 * unrecognised message is `task`, a class rather than a shrug, so no
 * caller has to decide what "no verdict" means.
 */
export function classify(error: ErrorLike | string | undefined): FailureClass {
  const status = typeof error === 'string' ? undefined : error?.status
  // Status first where it is decisive, because it is the structured signal and
  // text matching is the fallback — not the other way round.
  if (status === 404 || status === 410) return 'withdrawn'
  if (status === 429) return 'rate_limited'

  const haystack = text(error)
  if (!haystack.trim()) return 'task'

  // Order matters. `withdrawn` is first for the reason
  // `quarantine.ts:80` gives: "deprecated" is a fact about the model itself, and
  // a block is the right verdict even when the provider also names the tier it
  // was reached on.
  if (WITHDRAWN_PATTERNS.some(pattern => pattern.test(haystack))) return 'withdrawn'
  if (REJECTED_PATTERNS.some(pattern => pattern.test(haystack))) return 'rejected'
  if (RATE_LIMITED_PATTERNS.some(pattern => pattern.test(haystack))) return 'rate_limited'
  if (TRANSPORT_PATTERNS.some(pattern => pattern.test(haystack))) return 'transport'
  if (INTERRUPTED_PATTERNS.some(pattern => pattern.test(haystack))) return 'interrupted'
  if (UNAVAILABLE_PATTERNS.some(pattern => pattern.test(haystack))) return 'unavailable'
  return 'task'
}

/**
 * Whether another model is worth trying.
 * Narrow on purpose: a caller gates a retry on this. A false positive re-runs real work
 * and cannot be undone; a false negative only leaves a dead model until the next re-resolve.
 * `withdrawn` and `rejected` both qualify. The first because the *next* model may work and
 * this one is not coming back; the second because a refusal describes the caller, not the model.
 * A rate limit does not qualify — the next-best model is usually the same provider on the same key.
 */
export function isWorthRetrying(error: ErrorLike | string | undefined): boolean {
  const failure = classify(error)
  return failure === 'withdrawn' || failure === 'rejected' || failure === 'transport'
}

/** Whether the message names the credential rather than the model. */
export function isCredentialRefusal(error: ErrorLike | string | undefined): boolean {
  return classify(error) === 'rejected'
}

/** One word per class, for a diagnostic that must not guess at wording. */
export function describeFailure(error: ErrorLike | string | undefined): string {
  return classify(error)
}
