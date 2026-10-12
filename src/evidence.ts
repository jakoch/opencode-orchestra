/**
 * Verification evidence. A model's "done" is a claim: the store watches which files a
 * tool wrote and whether a check ran afterwards. Advisory throughout — nothing here
 * blocks, throws, or fails a request over an unbacked claim.
 */

import { roleSpec } from './agents'
import type { EvidenceSummary } from './telemetry'
import type { Claim, ClaimSupport, FileRef, HandoffEnvelope, RoleName } from './types'
import { HANDOFF_LIMITS, ROLES } from './types'

/** Tools that mutate files, across host and plugin naming. */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'patch',
  'multiedit',
  'multi_patch',
  'apply_patch',
  'sed_replace',
  'ast_replace'
])

/** Tools whose arguments contain a command string we can inspect. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'run_command', 'run_background'])

/** A command counts as verification when it runs tests, builds, or linters. */
const VERIFY_HINT =
  /\b(test|spec|vitest|jest|pytest|playwright|build|tsc|typecheck|lint|eslint|prettier|clippy|cargo\s+(test|check|clippy)|npm\s+(run\s+)?(test|build)|go\s+test|make(\s+test|\s+check)?|check)\b/i

const FILE_KEYS = ['filePath', 'filepath', 'file_path', 'path', 'file'] as const
const FILE_LIST_KEYS = ['files', 'filePaths', 'file_paths', 'paths'] as const

/** Cap so a long session cannot grow this without bound. Oldest entries go first. */
const MAX_TRACKED_FILES = 200

/** Exported for the self-test, which needs to push past the cap deliberately. */
export const EVIDENCE_FILE_CAP = MAX_TRACKED_FILES

/** Same bound and the same oldest-first policy as the file list. */
const MAX_TRACKED_CLAIMS = 24

/** Exported for the same reason as the file cap. */
export const EVIDENCE_CLAIM_CAP = MAX_TRACKED_CLAIMS

/** A claim is one line. Past this it stops being scannable, so the rest is dropped. */
const MAX_CLAIM_CHARS = 200

const MAX_RENDERED_CLAIMS = 4
const MAX_RENDERED_REFS = 3

/**
 * `path:line` on its own, with nothing around it. Anchored per token rather than
 * scanned inline so a URL or a bare number cannot pass as a location.
 */
const FILE_REF_HINT = /^(?:\.{0,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8}:\d+$/

const CLAIMS_FOOTER =
  'An unbacked claim is a gap, not a failure. Settle one by running the command it cites; ' +
  'do not re-run a search a role already ran, and no advisor verdict waits on you.'

interface StoredClaim {
  claim: Claim
}

/** A claim filed this session, with its support resolved at read time. */
export interface ClaimRecord {
  claim: Claim
  support: ClaimSupport
  backedBy?: string
  gap?: string
}

/** What `recordClaim` did. A reason is a note for the caller, never a gate. */
export interface ClaimVerdict {
  accepted: boolean
  reason?: string
}

export interface SessionEvidence {
  /** Written since the last recognized verification run. */
  unverified: Set<string>
  lastVerification?: { command: string; at: number }
  verificationRuns: number
  lastSeen: number
  claims: StoredClaim[]
}

export interface EvidenceOptions {
  ttlMs?: number
  now?: number
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000

export class EvidenceStore {
  private readonly sessions = new Map<string, SessionEvidence>()
  private readonly ttlMs: number

  constructor(options: EvidenceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  private state(sessionID: string): SessionEvidence {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { unverified: new Set(), verificationRuns: 0, lastSeen: Date.now(), claims: [] }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  record(
    sessionID: string,
    tool: string,
    input: unknown,
    status: string,
    now = Date.now()
  ): { verified: boolean; command?: string; unverifiedCount: number; cleared?: number } {
    const state = this.state(sessionID)
    state.lastSeen = now

    // A failed verification run does not clear the debt: the files it was meant to
    // check are still unchecked.
    if (status === 'error') {
      if (SHELL_TOOLS.has(tool)) {
        const command = shellCommand(input)
        if (command && VERIFY_HINT.test(command)) state.lastVerification = { command, at: now }
      }
      return { verified: false, command: state.lastVerification?.command, unverifiedCount: state.unverified.size }
    }

    if (WRITE_TOOLS.has(tool)) {
      for (const path of collectPaths(input)) {
        // Bound the record by evicting the oldest entry, never by clearing it:
        // wiping the set would report zero unverified files exactly when the session
        // has the most of them.
        while (state.unverified.size >= MAX_TRACKED_FILES) {
          const oldest = state.unverified.values().next()
          if (oldest.done) break
          state.unverified.delete(oldest.value)
        }
        state.unverified.add(path)
      }
      return { verified: false, unverifiedCount: state.unverified.size }
    }

    if (SHELL_TOOLS.has(tool)) {
      const command = shellCommand(input)
      if (command && VERIFY_HINT.test(command)) {
        state.verificationRuns++
        state.lastVerification = { command, at: now }
        // The run happened after the last edit, so the debt is settled.
        const cleared = state.unverified.size
        state.unverified.clear()
        return { verified: true, command, unverifiedCount: 0, cleared }
      }
    }

    return { verified: false, command: state.lastVerification?.command, unverifiedCount: state.unverified.size }
  }

  /** Total unverified files, including those beyond the preview slice. */
  count(sessionID: string): number {
    return this.sessions.get(sessionID)?.unverified.size ?? 0
  }

  latest(sessionID: string): string | undefined {
    const files = this.sessions.get(sessionID)?.unverified
    if (!files?.size) return undefined
    return [...files].at(-1)
  }

  snapshot(sessionID: string): {
    unverified: string[]
    lastVerification?: { command: string; at: number }
    verificationRuns: number
  } {
    const state = this.sessions.get(sessionID)
    return {
      unverified: state ? [...state.unverified].slice(0, 20) : [],
      lastVerification: state?.lastVerification,
      verificationRuns: state?.verificationRuns ?? 0
    }
  }

  describe(sessionID: string, now = Date.now()): string | undefined {
    const state = this.sessions.get(sessionID)
    if (!state) return undefined
    if (state.unverified.size === 0 && !state.lastVerification) return undefined

    if (state.unverified.size > 0) {
      const files = [...state.unverified].slice(0, 3)
      const more = state.unverified.size - files.length
      const since = state.lastVerification
        ? 'since your last verification run'
        : 'and no verification run has been recorded yet'
      return `${state.unverified.size} file(s) changed ${since}: ${files.join(', ')}${more > 0 ? `, +${more} more` : ''}. Run the checks before reporting done.`
    }
    const age = Math.round((now - state.lastVerification!.at) / 1000)
    return `Last verification run: \`${truncate(state.lastVerification!.command, 80)}\` (${age}s ago, ${state.verificationRuns} run(s) this session).`
  }

  /**
   * Never throws and never blocks. The input is a model's reply, so nothing here may
   * assume it is well formed: an unusable claim is dropped with a reason for the caller.
   */
  recordClaim(sessionID: string, input: Claim, now = Date.now()): ClaimVerdict {
    const state = this.state(sessionID)
    state.lastSeen = now

    const raw = input as Partial<Claim> | null | undefined
    const role = raw?.role
    if (!role || !ROLES.includes(role)) return { accepted: false, reason: 'the claim names no known role' }

    const text = oneLine(raw.claim)
    if (!text) return { accepted: false, reason: 'the claim carried no text' }

    const claim: Claim = { role, claim: truncate(text, MAX_CLAIM_CHARS) }
    const refs = normalizeRefs(raw.refs)
    if (refs.length) claim.refs = refs
    const command = oneLine(raw.command)
    if (command) claim.command = truncate(command, MAX_CLAIM_CHARS)

    // Evicting rather than clearing: a reset would blank the claims exactly when a
    // session has the most of them.
    while (state.claims.length >= MAX_TRACKED_CLAIMS) state.claims.shift()
    state.claims.push({ claim })
    return { accepted: true }
  }

  /**
   * Support is resolved now, not when the claim was filed: one filed before the
   * builder ran its checks is unbacked for a moment and observed afterwards.
   */
  claims(sessionID: string): ClaimRecord[] {
    const state = this.sessions.get(sessionID)
    if (!state?.claims.length) return []
    return state.claims.map(entry => ({ claim: entry.claim, ...resolveSupport(entry.claim, state) }))
  }

  /**
   * The claims block for the report, or undefined when there is nothing to say.
   * Phrased here because every clause is derived from session internals a renderer
   * cannot see; `report.ts` owns the section this lands in.
   */
  /**
   * Verification and claim counts for one session, for `describeTelemetry`.
   *
   * Read rather than mirrored: this store already owns both facts, and a second
   * tally kept alongside it is the kind of thing that reads plausible after the
   * store is cleared and quietly disagrees from then on.
   */
  summarize(sessionID: string): EvidenceSummary {
    const state = this.sessions.get(sessionID)
    const claims = this.claims(sessionID)
    const tally = { observed: 0, referenced: 0, unbacked: 0 }
    for (const record of claims) tally[record.support] += 1
    return {
      verificationRuns: state?.verificationRuns ?? 0,
      unverifiedFiles: state?.unverified.size ?? 0,
      claims: tally
    }
  }

  describeClaims(sessionID: string): string[] | undefined {
    const records = this.claims(sessionID)
    if (!records.length) return undefined

    const lines = [
      'Claims below are references, not copies: what a role said, where it points, and what backs it. None of them is a gate.'
    ]
    for (const record of records.slice(-MAX_RENDERED_CLAIMS)) lines.push(describeClaim(record))
    const hidden = records.length - MAX_RENDERED_CLAIMS
    if (hidden > 0) lines.push(`${hidden} earlier claim(s) from this session are not shown.`)
    lines.push(CLAIMS_FOOTER)
    return lines
  }

  prune(now = Date.now()): void {
    for (const [sessionID, state] of this.sessions) {
      if (now - state.lastSeen > this.ttlMs) this.sessions.delete(sessionID)
    }
  }

  clear(sessionID?: string): void {
    if (sessionID) this.sessions.delete(sessionID)
    else this.sessions.clear()
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Reads only the fields the envelope already declares: no prose is parsed and no
 * command guessed out of a sentence, because a wrong command is worse than none.
 */
export function claimsFromEnvelope(role: RoleName, envelope: HandoffEnvelope): Claim[] {
  const findings = Array.isArray(envelope?.findings) ? envelope.findings : []
  const refs = normalizeRefs(envelope?.filesTouched)
  const claims: Claim[] = []
  for (const finding of findings.slice(0, HANDOFF_LIMITS.maxFindings)) {
    const text = oneLine(finding)
    if (!text) continue
    claims.push(
      refs.length
        ? { role, claim: truncate(text, MAX_CLAIM_CHARS), refs }
        : { role, claim: truncate(text, MAX_CLAIM_CHARS) }
    )
  }
  return claims
}

/**
 * The strongest available answer is "a run this store recorded", read out of the
 * fields above — never by running anything, which is the builder's decision to make.
 */
function resolveSupport(claim: Claim, state: SessionEvidence): Pick<ClaimRecord, 'support' | 'backedBy' | 'gap'> {
  const label = roleSpec(claim.role).name
  const refs = claim.refs?.length ?? 0

  if (!claim.command) {
    if (refs) return { support: 'referenced', backedBy: 'the reference alone, which is a location and not a result' }
    return {
      support: 'unbacked',
      gap: 'it cites neither a reference nor a command, so nothing in this session backs it'
    }
  }

  // The verification boundary, mechanically (see docs/roles.md): a role denied shell cannot have
  // run the command it names, whatever this session happens to have recorded.
  if (!canRunCommands(claim.role)) {
    return {
      support: 'unbacked',
      gap: `the ${label} is denied shell, so it cannot have run this; only the builder can settle it`
    }
  }
  if (!VERIFY_HINT.test(claim.command)) {
    return {
      support: 'unbacked',
      gap: `\`${truncate(claim.command, 60)}\` is not a check this session can back`
    }
  }
  const run = state.lastVerification
  if (!run) return { support: 'unbacked', gap: 'no verification run has been recorded this session' }
  // Reuses the file tracker rather than a second opinion: an unverified file is
  // exactly why a past run does not cover the present.
  if (state.unverified.size) {
    return {
      support: 'unbacked',
      gap: `${state.unverified.size} file(s) changed after the last run, so that run does not cover this`
    }
  }
  if (!sameCommand(run.command, claim.command)) {
    return { support: 'unbacked', gap: `the last run was \`${truncate(run.command, 60)}\`, not the cited one` }
  }
  return { support: 'observed', backedBy: `\`${truncate(run.command, 60)}\` ran after the last edit` }
}

/**
 * Derived from the agent definitions rather than restated: a table here would be a
 * second source of truth for a fact `src/agents.ts` already owns, and the two would
 * drift silently. Rules are ordered and the last match wins, `*` matching every action.
 */
function canRunCommands(role: RoleName): boolean {
  const rules = roleSpec(role).permissions
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index]!
    if (rule.action === 'shell' || rule.action === '*') return rule.effect !== 'deny'
  }
  return false
}

/**
 * No leading `- `: the entry is a plain line because `renderReport` owns the bullet,
 * exactly as it does for `signals` and `warnings`.
 */
function describeClaim(record: ClaimRecord): string {
  const { claim, support, backedBy, gap } = record
  const refs = claim.refs ?? []
  const shown = refs.slice(0, MAX_RENDERED_REFS).map(ref => `\`${ref}\``)
  if (refs.length > MAX_RENDERED_REFS) shown.push(`+${refs.length - MAX_RENDERED_REFS} more`)
  const cited = claim.command ? `, command \`${truncate(claim.command, 60)}\`` : ''
  const where = shown.length ? shown.join(', ') : 'nothing cited'
  const backing = support === 'unbacked' ? `nothing here — ${gap}` : (backedBy ?? '')
  return `${roleSpec(claim.role).name} — "${claim.claim}" — where: ${where}${cited}; backed by: ${backing}.`
}

/** Flattens a value to one line, so a claim cannot smuggle prose into a report. */
function oneLine(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A loose shape check, not an existence check: confirming a reference resolves would
 * mean reading the tree on every report, and a missing file is a stale location,
 * not a claim being wrong.
 */
function normalizeRefs(refs: unknown): FileRef[] {
  if (!Array.isArray(refs)) return []
  const kept = new Set<string>()
  for (const ref of refs) {
    if (typeof ref !== 'string') continue
    const trimmed = ref.trim()
    if (FILE_REF_HINT.test(trimmed)) kept.add(trimmed)
    if (kept.size >= HANDOFF_LIMITS.maxFiles) break
  }
  return [...kept] as FileRef[]
}

/** Two commands name the same check when one contains the other, modulo whitespace. */
function sameCommand(recorded: string, cited: string): boolean {
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')
  const a = normalize(recorded)
  const b = normalize(cited)
  return a === b || a.includes(b) || b.includes(a)
}

/** Pulls the command string out of the various shell-tool argument shapes. */
export function shellCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (typeof record.command === 'string') return record.command
  if (Array.isArray(record.args) && record.args.every(arg => typeof arg === 'string')) {
    return record.args.join(' ')
  }
  return undefined
}

function collectPaths(input: unknown, depth = 0): string[] {
  if (!input || typeof input !== 'object' || depth > 3) return []
  const record = input as Record<string, unknown>
  const found: string[] = []

  for (const key of FILE_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length) found.push(value)
  }
  for (const key of FILE_LIST_KEYS) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (typeof item === 'string') found.push(item)
      else found.push(...collectPaths(item, depth + 1))
    }
  }
  return found
}

/**
 * A digest of a tool's *result*, for deciding whether two identical calls were
 * also identical in what they produced.
 *
 * Text only, and bounded: this is the "did anything change" signal, not the
 * answer, so the first slice of the text is enough and a 200MB stdout cannot
 * cost a full-string hash. Anything the host shapes differently is stable for
 * that shape, which is all that is asked of it.
 *
 * `status` is part of the digest deliberately: a call that failed and one that
 * succeeded are not the same call, and `prompts.ts` tells the model to re-run
 * a failing check — which must not read as a loop.
 */
export function resultDigest(event: { status?: string; result?: unknown; error?: unknown }): string {
  if (event.status === 'error') return 'error'
  const result = event.result
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') return result.slice(0, 200)
  if (typeof result !== 'object') return String(result)
  const content = (result as { content?: unknown }).content
  if (content === undefined) {
    try {
      return JSON.stringify(result).slice(0, 200)
    } catch {
      return ''
    }
  }
  try {
    return JSON.stringify(content).slice(0, 200)
  } catch {
    return ''
  }
}

/**
 * Matches the **last** segment rather than the first: a host namespace can itself
 * contain an underscore (`plugins_orchestra_subagent`), and splitting on the first
 * would leave `orchestra_subagent`, matching neither the gate nor `WRITE_TOOLS` and
 * silently disabling both.
 */
export function effectiveToolId(id: string): string {
  const index = id.lastIndexOf('_')
  return index === -1 ? id : id.slice(index + 1)
}
