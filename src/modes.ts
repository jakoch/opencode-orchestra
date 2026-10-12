/**
 * Operating modes.
 *
 * The temptation is to read a mode as a paragraph of prompt edits — tell the
 * builder to call the advisor less often. That saves nothing: the tools are
 * registered either way, so the model may ignore the advice and the turn is
 * spent regardless. A cost control the model is free to decline is not a cost
 * control.
 *
 * So a mode here is a **structural preset over the role set**, expressed in the
 * `roles: { advisor: null }` form that already existed. Minimal removes the
 * reviewer roles; their tools are never registered, so a call to one cannot
 * become a delegation. That is a saving the model cannot talk its way out of.
 *
 * **What Minimal deliberately does not remove: the scout.** Handoff is a core
 * task — the builder's operating model is built on not opening files it was not
 * handed — so Minimal means "no extra reviewers", never "no delegation".
 *
 * **What no mode can do, stated rather than faked:**
 *
 * - `strict` cannot force a review *before a commit*. There is no commit hook;
 *   `agents.ts` sets `git push *` to `ask` and nothing observes `git commit`.
 *   Strict is therefore advisory on that point, and says so.
 * - `strict` adds no role — all four are already present in `standard`. What it
 *   changes is frequency, and frequency is only expressible as advice: see
 *   `strictPromptGuidance` in `prompts.ts`, which is where that text lives
 *   rather than here, because this module is policy and the prompt file is the
 *   prompt.
 * - Nothing here caps reviewer turns per session. A mode chooses which roles
 *   exist; a turn ceiling is a separate mechanism and is not one of these.
 * - The `subagent` fallback reroutes a refused native launch to whichever roles
 *   are active, so removing a role does remove that path to it.
 *
 * **The boundaries are unvalidated.** Sizing them properly wants real usage —
 * how many advisor and skeptic turns a session actually gets through — and
 * `usage-window.ts` reports that. On an install whose credential refuses every
 * programmatic delegation the counters stay empty, so these are reasoned
 * defaults rather than measured ones, and `STANDARD` is the default for that
 * reason: the unvalidated modes are opt-in.
 */

import type { OperatingMode } from './modes-types'
import { ROLES, type RoleName } from './types'

// Re-exported so callers take one import for a mode and what it does. The values
// live in `modes-types` so `prompts.ts` can name the type without importing this
// module, which would be the cycle.
export { DEFAULT_MODE, isOperatingMode, OPERATING_MODES, type OperatingMode } from './modes-types'

/**
 * The roles each mode keeps.
 *
 * `minimal` drops the two reviewers and nothing else. The skeptic is included
 * in the drop because its whole purpose is arguing against a proposal the user
 * has not yet committed to — a mode for working on a decided task has no use
 * for it, and it is the most expensive role to call speculatively.
 */
export const MODE_ROLES: Record<OperatingMode, readonly RoleName[]> = {
  minimal: ['builder', 'scout'],
  standard: ['builder', 'scout', 'advisor', 'skeptic'],
  strict: ['builder', 'scout', 'advisor', 'skeptic']
}

/**
 * The role overrides a mode implies, in the `roles` option's own shape.
 *
 * Merged *under* an explicit `roles` option rather than over it: someone who
 * writes `mode: "minimal"` and separately pins `{ "advisor": "..." }` has said
 * what they want, and a preset that overrode the specific would be a surprise.
 * `null` disables a role, which is how a user re-enables one against a mode
 * (`{ "advisor": null }` in `roles` wins, because it is the more specific
 * statement).
 */
export function modeRoleOverrides(
  mode: OperatingMode,
  roles: Partial<Record<RoleName, string | null>> | undefined
): Partial<Record<RoleName, string | null>> {
  const implied: Partial<Record<RoleName, string | null>> = {}
  for (const role of ROLES) {
    if (!MODE_ROLES[mode].includes(role)) implied[role] = null
  }
  // An explicit key from the user wins, including an explicit `null` — which is
  // how a role comes back against a mode that drops it.
  for (const [role, value] of Object.entries(roles ?? {})) {
    implied[role as RoleName] = value as string | null
  }
  return implied
}

/**
 * Whether strict should also tighten the builder's own instructions.
 *
 * The text lives in `prompts.ts` beside the prompt it extends — `modes.ts` is
 * policy, and policy that reached into the prompt file to hold a paragraph of
 * English would be the dependency that put the two in a cycle.
 */
