/**
 * Delegation receipts — durable state across compaction. A receipt is a pointer, not
 * a transcript: every text field is clipped and the clip is stated, because an excerpt
 * that reads as complete is worse than none. `uncertain` is the default status.
 */

import { type OutcomeStatus, outcomeFor } from './outcome'
import type { RoleName } from './types'

/**
 * `delivered` — the role returned text. `failed` — it failed in a way that says it
 * produced nothing. `uncertain` — the outcome was never observed: killed, timed out,
 * or still in flight. Never rendered as completion.
 */
/**
 * What became of the turn.
 *
 * `refused` is new and load-bearing: the provider declined, so the work was
 * never judged. It used to land in `failed`, which told the builder the scout
 * had found nothing — the opposite of what a credential refusal means, and a
 * message the model then repeats to the user.
 */
export type ReceiptStatus = 'uncertain' | 'delivered' | 'refused' | 'failed'

/**
 * The statuses a persisted receipt may carry.
 *
 * Enumerated once so the shape check on restore cannot drift from the union —
 * which is how a status would be accepted by the type and then silently dropped
 * on the way back out of storage.
 */
const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['uncertain', 'delivered', 'refused', 'failed']

export type ReceiptField = 'question' | 'reply' | 'detail'

export interface Receipt {
  id: string
  sessionID: string
  role: RoleName
  question: string
  reply?: string
  detail?: string
  /** Which fields were clipped, so a cut excerpt never reads as a whole one. */
  cut: ReceiptField[]
  status: ReceiptStatus
  /** Refs the dispatch walked, in order. One entry means no fallback fired. */
  tried: string[]
  /** Set once the answer has been seen in the builder's own transcript. */
  consumed: boolean
  at: number
}

/** Enough to cover a long task, few enough that a delegating loop cannot grow it without bound. */
const RECEIPTS_PER_SESSION = 20

/** Exported for the self-test, which needs to push past the cap deliberately. */
export const RECEIPT_CAP = RECEIPTS_PER_SESSION

/** Long enough to recognise the request; the builder still has the full one in its transcript. */
const QUESTION_LIMIT = 160

/** Four times the question: the answer is what compaction loses, but a receipt is still a summary. */
const REPLY_LIMIT = 400

/** Failure text. Errors are already clipped at 300 chars upstream; same order. */
const DETAIL_LIMIT = 200

/**
 * Also the marker for "this is not evidence the builder read it". The receipt's own
 * excerpt appears in the prompt it is re-injected into, so a scan counting our own
 * reminder would mark the receipt consumed on the very next turn.
 */
export const RECEIPT_MARKER = '[delegation receipt]'

/** Receipts put into one prompt, newest first. The rest are counted, not shown. */
const MAX_INJECTED = 4

/**
 * Bounded even when each line would fit inside `MAX_INJECTED`: the builder's context is
 * the scarce resource. One the budget cannot fit is named "not shown", never omitted.
 */
const INJECT_LIMIT = 1400

/**
 * The consumption check is a substring search, so a two-character reply ("ok") would
 * match somewhere and retire a receipt nobody read. Below this, losing a finding is worse.
 */
const MIN_CONSUMPTION_MATCH = 32

/** Two hours, matching `EvidenceStore`: outlasts the compaction that dropped a finding. */
const TTL_MS = 2 * 60 * 60 * 1000

/** Bumped when the persisted shape changes; anything else is ignored on load. */
const SNAPSHOT_VERSION = 1

export interface ReceiptSnapshot {
  version: number
  sessions: Record<string, Receipt[]>
}

/**
 * What `settle` is told. `DelegationResult` satisfies this as-is.
 *
 * `status` is optional so a caller holding only a string can settle a receipt,
 * but when it is present it wins: the dispatcher has already classified the
 * turn, and classifying the same message a second time is how two records of one
 * dispatch come to disagree.
 */
export interface ReceiptOutcome {
  ok: boolean
  status?: OutcomeStatus
  text?: string
  error?: string
}

export interface ReceiptStoreOptions {
  perSession?: number
  ttlMs?: number
  now?: () => number
}

/**
 * Whether a failure means "nothing came back" or "nobody knows".
 *
 * A policy over the shared classification in `src/failure.ts`. A timeout or a
 * cancellation kills a turn mid-sentence: calling that a failure asserts an
 * outcome nobody observed, and the builder will then report there was nothing
 * to find.
 *
 * Deliberately narrower than `quarantine.ts`'s retry predicate, and they
 * disagree on purpose. A timeout is worth neither retrying nor blaming, but a
 * receipt must still call it unclear.
 */
/**
 * Whether the outcome was never observed.
 *
 * A view over the outcome mapping rather than a second decision: a timeout or a
 * cancellation kills a turn mid-sentence, and calling that a failure asserts an
 * outcome nobody saw. A rate limit and a degraded gateway join it — the work was
 * never judged there either, so the receipt must not say it was.
 */
export function isUnclearOutcome(error: string | undefined): boolean {
  return outcomeFor(error).status === 'uncertain'
}

export class ReceiptStore {
  private readonly sessions = new Map<string, Receipt[]>()
  private readonly perSession: number
  private readonly ttlMs: number
  private readonly now: () => number
  private counter = 0

  constructor(options: ReceiptStoreOptions = {}) {
    this.perSession = options.perSession ?? RECEIPTS_PER_SESSION
    this.ttlMs = options.ttlMs ?? TTL_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Opened *before* the provider call, and as `uncertain`, because until the dispatch
   * returns nothing is known. A store that only learned about finished runs would have
   * nothing to say about the one that was cut short.
   */
  begin(sessionID: string, role: RoleName, question: string): Receipt {
    const list = this.list(sessionID)
    const clipped = clip(question, QUESTION_LIMIT)
    const receipt: Receipt = {
      id: `rcpt_${this.now()}_${this.counter++}`,
      sessionID,
      role,
      question: clipped.text,
      cut: clipped.cut ? ['question'] : [],
      status: 'uncertain',
      tried: [],
      consumed: false,
      at: this.now()
    }
    list.push(receipt)
    // Bounded by evicting the oldest, never by clearing: wiping the list would report
    // an empty history exactly when the session has the most of it.
    if (list.length > this.perSession) list.splice(0, list.length - this.perSession)
    return receipt
  }

  /**
   * Returns `undefined` when the receipt is gone — evicted by the cap while the run was
   * still going. Not worth inventing a record for: a receipt dropped for space cannot
   * also claim to know the outcome.
   */
  settle(sessionID: string, id: string, outcome: ReceiptOutcome, tried: string[] = []): Receipt | undefined {
    const receipt = this.sessions.get(sessionID)?.find(entry => entry.id === id)
    if (!receipt) return undefined
    receipt.tried = [...tried]
    receipt.at = this.now()

    // One decision, taken once. A caller that already classified the dispatch hands
    // the status in; a caller holding only a string has it classified here.
    const status = outcome.status ?? (outcome.ok && outcome.text ? 'delivered' : outcomeFor(outcome.error).status)

    if (status === 'delivered' && outcome.text) {
      const reply = clip(outcome.text, REPLY_LIMIT)
      receipt.status = 'delivered'
      receipt.reply = reply.text
      if (reply.cut) receipt.cut.push('reply')
      return receipt
    }

    const detail = clip(outcome.error ?? 'the delegation produced no reply', DETAIL_LIMIT)
    receipt.detail = detail.text
    if (detail.cut) receipt.cut.push('detail')
    // A `delivered` verdict with no text is not an answer, whatever the caller
    // said: the receipt describes what the builder can read, not what was hoped.
    receipt.status = status === 'delivered' ? 'failed' : status
    return receipt
  }

  list(sessionID: string): Receipt[] {
    const existing = this.sessions.get(sessionID)
    if (existing) return existing
    const created: Receipt[] = []
    this.sessions.set(sessionID, created)
    return created
  }

  unconsumed(sessionID: string): Receipt[] {
    return this.sessions.get(sessionID)?.filter(receipt => !receipt.consumed) ?? []
  }

  /** Returns how many changed, so the caller can skip a write when nothing did. */
  noteTranscript(sessionID: string, transcript: readonly unknown[]): number {
    const pending = this.unconsumed(sessionID)
    if (!pending.length || !Array.isArray(transcript)) return 0
    // One haystack per turn, and only while something is pending: the transcript is
    // the expensive part. Entries this module injected are excluded — that is what
    // `RECEIPT_MARKER` is for, otherwise a reminder would mark itself read.
    const haystack = transcript
      .map(entry => entryText(entry))
      .filter(text => !text.includes(RECEIPT_MARKER))
      .join('\n')
    let consumed = 0
    for (const receipt of pending) {
      const needle = receipt.reply ?? receipt.detail
      // No text means the dispatch never settled, so nothing could have reached the builder.
      if (!needle || !transcriptCarries(haystack, needle, receipt.question)) continue
      receipt.consumed = true
      receipt.at = this.now()
      consumed += 1
    }
    return consumed
  }

  /**
   * Re-opens every consumed receipt. Called when the host says the turn it is about to
   * run is a compaction — the one moment the builder can have lost an answer it had.
   * Opportunistic: the context hook's `kind` is absent on the running host.
   */
  reopen(sessionID: string): number {
    const list = this.sessions.get(sessionID)
    if (!list) return 0
    let reopened = 0
    for (const receipt of list) {
      if (!receipt.consumed) continue
      receipt.consumed = false
      reopened += 1
    }
    return reopened
  }

  /**
   * Newest first when choosing what fits, oldest first when rendering: the builder reads
   * the session in order and the budget is spent on what just happened.
   */
  injection(sessionID: string): string | undefined {
    const pending = this.unconsumed(sessionID)
    if (!pending.length) return undefined

    const shown: string[] = []
    let length = 0
    for (const receipt of [...pending].reverse()) {
      if (shown.length >= MAX_INJECTED) break
      const line = describe(receipt)
      // Always show the newest one: a pending receipt the budget cannot fit would
      // otherwise vanish while the header still counts it.
      if (shown.length && length + line.length > INJECT_LIMIT) break
      shown.push(line.length > INJECT_LIMIT ? clip(line, INJECT_LIMIT).text : line)
      length += line.length
    }
    shown.reverse()

    const dropped = pending.length - shown.length
    const header =
      `${RECEIPT_MARKER} ${pending.length} delegation(s) in this session whose answer is not in your context` +
      (dropped ? ` (showing the ${shown.length} newest; ${dropped} not shown)` : '') +
      '. Each line is a pointer, not a transcript — re-ask the role for detail.'
    return [header, ...shown.map(line => `- ${line}`)].join('\n')
  }

  prune(): number {
    const cutoff = this.now() - this.ttlMs
    let dropped = 0
    for (const [sessionID, list] of this.sessions) {
      // The newest *activity*, not the newest receipt: settling or consuming an old
      // receipt moves its timestamp forward, and that session is not idle.
      let newest = 0
      for (const receipt of list) newest = Math.max(newest, receipt.at)
      if (newest < cutoff) {
        this.sessions.delete(sessionID)
        dropped += 1
      }
    }
    return dropped
  }

  /**
   * Only unconsumed receipts are persisted: a consumed one has nothing left to restore,
   * and writing it back would re-overtake it on the next start.
   */
  snapshot(): ReceiptSnapshot {
    const sessions: Record<string, Receipt[]> = {}
    for (const [sessionID, list] of this.sessions) {
      const pending = list.filter(receipt => !receipt.consumed)
      if (pending.length) sessions[sessionID] = pending.map(receipt => ({ ...receipt, cut: [...receipt.cut] }))
    }
    return { version: SNAPSHOT_VERSION, sessions }
  }

  /**
   * Everything that fails a shape check is dropped rather than repaired: this is
   * untrusted input from a storage key, and a half-restored receipt would be re-injected
   * as fact.
   */
  restore(raw: unknown): number {
    const snapshot = raw as ReceiptSnapshot | undefined
    if (!snapshot || typeof snapshot !== 'object') return 0
    if (snapshot.version !== SNAPSHOT_VERSION || !snapshot.sessions || typeof snapshot.sessions !== 'object') return 0
    let restored = 0
    for (const [sessionID, list] of Object.entries(snapshot.sessions)) {
      if (!Array.isArray(list)) continue
      const receipts = list.filter(isReceipt).slice(-this.perSession)
      if (!receipts.length) continue
      this.sessions.set(
        sessionID,
        receipts.map(receipt => ({ ...receipt, cut: [...receipt.cut] }))
      )
      restored += receipts.length
    }
    return restored
  }

  clear(sessionID?: string): void {
    if (sessionID) this.sessions.delete(sessionID)
    else this.sessions.clear()
  }
}

/**
 * The status token comes first and in caps, so `UNCERTAIN` cannot be read as
 * `DELIVERED` in a paragraph of injected text — the failure this status exists to prevent.
 */
function describe(receipt: Receipt): string {
  const asked = `"${receipt.question}"${receipt.cut.includes('question') ? '…' : ''}`
  const head = `${receipt.role} · ${receipt.status.toUpperCase()} · asked ${asked}`
  if (receipt.status === 'delivered') {
    const reply = receipt.reply ?? ''
    return `${head} · reply${receipt.cut.includes('reply') ? ' (truncated)' : ''}: ${reply}${receipt.cut.includes('reply') ? '…' : ''}`
  }
  if (receipt.status === 'uncertain') {
    // Wording that cannot be mistaken for a result, whatever the detail says.
    const why = receipt.detail ? `outcome never observed (${receipt.detail})` : 'outcome never observed'
    return `${head} · ${why} — this is not a result; do not rely on it, and do not report it as done.`
  }
  if (receipt.status === 'refused') {
    // The one the builder most needs not to misreport: the turn was refused
    // before the work was judged, so "nothing to find" is not what happened.
    // `last` is the model that would need a different pin.
    const refusedOn = receipt.tried.at(-1)
    const which = refusedOn ? ` on \`${refusedOn}\`` : ''
    const why = receipt.detail ? `refused${which}: ${receipt.detail}` : `refused${which}`
    return `${head} · ${why} — the work was never run; pin a model that answers before drawing a conclusion.`
  }
  const detail = receipt.detail ?? 'no reason was recorded'
  // `/orchestra` owns the full chain; the one fact worth the builder's context is which
  // model the answer did not come back from, because that is what a pin would change.
  const last = receipt.tried.at(-1)
  const on = last && !detail.includes(last) ? ` on \`${last}\`` : ''
  return `${head} · reason${on}: ${detail}${receipt.cut.includes('detail') ? '…' : ''}`
}

/** Cuts text at a limit and says whether it did, so a clip is never silent. */
function clip(text: string, limit: number): { text: string; cut: boolean } {
  const trimmed = text.trim()
  return trimmed.length > limit ? { text: trimmed.slice(0, limit), cut: true } : { text: trimmed, cut: false }
}

/** Whitespace-insensitive, for the containment test below rather than the search. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Whether the builder's transcript shows the answer reaching it.
 *
 * The search is textual because there is nothing else to search: transcript
 * entries carry host-generated message ids that cannot be correlated to a
 * receipt (see `docs/host-behavior.md` H14), and the delegation tool's own
 * result is the legitimate signal — that is a real consumption event, not a
 * false positive, and this is why the haystack is the whole transcript rather
 * than only the assistant's prose.
 *
 * What does produce a false positive: the builder's transcript has contained
 * the *question* since the moment the tool call was recorded, so a reply that
 * merely quotes the question back — a scout restating a long "where is X?" —
 * matches text that was there before any answer existed. The receipt retires
 * without the builder ever having read a thing, and a later compaction then has
 * nothing left to re-offer. So a reply carrying no words the question did not
 * already contain is not evidence of reading.
 */
function transcriptCarries(haystack: string, needle: string, question: string): boolean {
  if (needle.length < MIN_CONSUMPTION_MATCH || !haystack) return false
  const flatNeedle = normalize(needle)
  const flatQuestion = normalize(question)
  // An answer no longer than the question, or one wholly inside it, added
  // nothing: the builder already held those words from making the call.
  //
  // Guarded on the question being non-empty. With no question recorded, nothing
  // can be a subset of anything, so the check is skipped rather than satisfied —
  // reading it as "the reply added nothing" would stop every such receipt from
  // ever being consumed.
  if (flatQuestion && (flatNeedle.length <= flatQuestion.length || flatQuestion.includes(flatNeedle))) return false
  return haystack.includes(needle)
}

/**
 * Read as data rather than parsed against a message shape: `delegate.ts` has already been
 * bitten once by guessing at `SessionMessageInfo` field names. Strings are joined, not
 * JSON-encoded — encoding escapes the newlines a multi-line reply is full of, and an
 * escaped needle never matches.
 */
function entryText(entry: unknown, depth = 0): string {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object' || depth > 4) return ''
  const parts: string[] = []
  for (const value of Object.values(entry as Record<string, unknown>)) {
    if (typeof value === 'string') parts.push(value)
    else if (value && typeof value === 'object') parts.push(entryText(value, depth + 1))
  }
  return parts.join('\n')
}

/** Structural check for a receipt read back from storage. */
function isReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<Receipt>
  return (
    typeof record.id === 'string' &&
    typeof record.sessionID === 'string' &&
    typeof record.question === 'string' &&
    typeof record.at === 'number' &&
    RECEIPT_STATUSES.includes(record.status as ReceiptStatus) &&
    Array.isArray(record.cut)
  )
}
