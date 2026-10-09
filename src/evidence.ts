/**
 * Verification evidence.
 *
 * A model's "done" is a claim. This module turns it into something checkable by
 * watching two things the host already reports: which files a tool wrote, and
 * whether a command that looks like verification ran afterwards. A file that was
 * edited after the last verification run is an *unverified* file, and the report
 * can say so instead of trusting the summary.
 *
 * The file list is advisory. It cannot prove code is correct, only that nothing
 * has been changed since the checks the model claims to have run.
 */

/** Tools that mutate files, across host and plugin naming. */
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
  "multi_patch",
  "apply_patch",
  "sed_replace",
  "ast_replace",
])

/** Tools whose arguments contain a command string we can inspect. */
const SHELL_TOOLS = new Set(["bash", "shell", "run_command", "run_background"])

/** A command counts as verification when it runs tests, builds, or linters. */
const VERIFY_HINT =
  /\b(test|spec|vitest|jest|pytest|playwright|build|tsc|typecheck|lint|eslint|prettier|clippy|cargo\s+(test|check|clippy)|npm\s+(run\s+)?(test|build)|go\s+test|make(\s+test|\s+check)?|check)\b/i

/** Argument keys that hold a single path. */
const FILE_KEYS = ["filePath", "filepath", "file_path", "path", "file"] as const

/** Argument keys that hold a list of paths. */
const FILE_LIST_KEYS = ["files", "filePaths", "file_paths", "paths"] as const

/** Cap so a long session cannot grow this without bound. Oldest entries go first. */
const MAX_TRACKED_FILES = 200

/** Exported for the self-test, which needs to push past the cap deliberately. */
export const EVIDENCE_FILE_CAP = MAX_TRACKED_FILES

export interface SessionEvidence {
  /** Written since the last recognized verification run. */
  unverified: Set<string>
  /** Most recent verification command, for display. */
  lastVerification?: { command: string; at: number }
  verificationRuns: number
  lastSeen: number
}

export interface EvidenceOptions {
  /** Forget sessions untouched for this long. */
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
      state = { unverified: new Set(), verificationRuns: 0, lastSeen: Date.now() }
      this.sessions.set(sessionID, state)
    }
    return state
  }

  /**
   * Records one completed tool call. Returns true when the call looked like a
   * verification run, so the caller can react to a completed check.
   */
  record(
    sessionID: string,
    tool: string,
    input: unknown,
    status: string,
    now = Date.now(),
  ): { verified: boolean; command?: string; unverifiedCount: number; cleared?: number } {
    const state = this.state(sessionID)
    state.lastSeen = now

    // A failed verification run does not clear the debt: the files it was
    // meant to check are still unchecked.
    if (status === "error") {
      if (SHELL_TOOLS.has(tool)) {
        const command = shellCommand(input)
        if (command && VERIFY_HINT.test(command)) state.lastVerification = { command, at: now }
      }
      return { verified: false, command: state.lastVerification?.command, unverifiedCount: state.unverified.size }
    }

    if (WRITE_TOOLS.has(tool)) {
      for (const path of collectPaths(input)) {
        // Bound the record by evicting the oldest entry, never by clearing it:
        // wiping the set would report zero unverified files exactly when the
        // session has the most of them.
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

  /** Most recently written path, used to prove eviction kept the newest. */
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
      verificationRuns: state?.verificationRuns ?? 0,
    }
  }

  /** One-line summary for the report and the builder prompt. */
  describe(sessionID: string, now = Date.now()): string | undefined {
    const state = this.sessions.get(sessionID)
    if (!state) return undefined
    if (state.unverified.size === 0 && !state.lastVerification) return undefined

    if (state.unverified.size > 0) {
      const files = [...state.unverified].slice(0, 3)
      const more = state.unverified.size - files.length
      const since = state.lastVerification
        ? "since your last verification run"
        : "and no verification run has been recorded yet"
      return `${state.unverified.size} file(s) changed ${since}: ${files.join(", ")}${more > 0 ? `, +${more} more` : ""}. Run the checks before reporting done.`
    }
    const age = Math.round((now - state.lastVerification!.at) / 1000)
    return `Last verification run: \`${truncate(state.lastVerification!.command, 80)}\` (${age}s ago, ${state.verificationRuns} run(s) this session).`
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

/** Pulls the command string out of the various shell-tool argument shapes. */
export function shellCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  if (typeof record.command === "string") return record.command
  if (Array.isArray(record.args) && record.args.every((arg) => typeof arg === "string")) {
    return record.args.join(" ")
  }
  return undefined
}

function collectPaths(input: unknown, depth = 0): string[] {
  if (!input || typeof input !== "object" || depth > 3) return []
  const record = input as Record<string, unknown>
  const found: string[] = []

  for (const key of FILE_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.length) found.push(value)
  }
  for (const key of FILE_LIST_KEYS) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (typeof item === "string") found.push(item)
      else found.push(...collectPaths(item, depth + 1))
    }
  }
  return found
}

/** Narrow a tool name to its effective id, which may be namespaced. */
export function effectiveToolId(id: string): string {
  const index = id.indexOf("_")
  return index === -1 ? id : id.slice(index + 1)
}