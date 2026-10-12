/**
 * Verify an assignment by request. The catalog is a claim: a model can be listed
 * active and still be refused at request time. A probe changes no stored state.
 */

import { classify } from './failure'
import type { FailureKind } from './quarantine'
import type { ModelRef, RoleName } from './types'
import { ROLES } from './types'

/** The slice of `ctx.generate` this module needs, so tests can inject a fake. */
export interface GenerateLike {
  text(input: {
    prompt: string
    model?: { id: string; providerID: string; variant?: string }
  }): Promise<{ text: string }>
}

/**
 * `generate.text` runs without a session, which is exactly what the free-tier guard
 * checks for, so it reports the block as a verdict on the model. A session route is
 * the closest a plugin gets to an in-app request: a second attempt, not a replacement.
 */
export interface SessionProbeLike {
  /**
   * `location` is what puts the probe's session in the project. Without it the
   * host creates it in the *server's* default directory, and prompting it boots
   * a second location there — a phantom workspace that outlives the session.
   */
  create(input?: { title?: string; location?: { directory: string } }): Promise<{
    id: string
    location?: { directory?: string }
  }>
  /**
   * Fallback for a host that ignores `create({ location })`. See `create` in
   * `src/plugin-types.ts` for what the wrong location costs.
   */
  move(input: { sessionID: string; directory: string }): Promise<void>
  switchAgent(input: { sessionID: string; agent: string }): Promise<void>
  switchModel(input: { sessionID: string; model: { providerID: string; id: string; variant?: string } }): Promise<void>
  prompt(input: { sessionID: string; text: string; delivery?: 'steer' | 'queue' }): Promise<unknown>
  wait(input: { sessionID: string }): Promise<void>
  remove(input: { sessionID: string }): Promise<void>
  context(input: { sessionID: string }): Promise<readonly unknown[]>
}

/**
 * `ok` and `refused` are both real answers from the provider; `unverified` means we
 * never got far enough to ask, and is not a verdict about the model.
 */
export type ProbeVerdict = 'ok' | 'refused' | 'unverified'

export interface ProbeResult {
  role: RoleName
  model?: ModelRef
  verdict: ProbeVerdict
  detail: string
  kind?: FailureKind
  elapsedMs: number
}

export interface ProbeOptions {
  /** Deliberately short: a hanging probe holds the command open with the user waiting. */
  timeoutMs?: number
  now?: () => number
}

export interface ProbeInput {
  /** Assignments to verify, keyed by role. */
  assignments: Partial<Record<RoleName, ModelRef | undefined>>
  /**
   * Single-shot generation. Optional: a host without `generate.text` cannot
   * run the cheap route, and the verdict is `unverified` — never `refused`,
   * so a missing host method is never misread as a dead model.
   */
  generate?: GenerateLike
  /** Heavier and writes history, so only paid for after the cheap path gives no answer. */
  session?: SessionProbeLike
  /**
   * Where the session-backed route runs. The probe switches no agent, but the
   * session still belongs to a location: prompting one opened in the server's
   * default directory boots that location on the server and leaves it there.
   */
  directory?: string
  options?: ProbeOptions
}

/**
 * 45s, not 20s: a cold first call has been measured at 13s for a one-word reply, and
 * a tighter budget reports a working model as unreachable.
 */
const DEFAULT_TIMEOUT_MS = 45_000

/** Prompts the probe sends. Kept tiny and dull: the answer is only "it replied". */
const PROBE_PROMPT = 'Reply with the single word: ok'

/**
 * Classifies an error we caught while probing.
 * A *policy* over the shared classification in `src/failure.ts`, not a second
 * classifier. It previously carried its own pattern tables, which disagreed with
 * `quarantine.ts`:
 * - `EPIPE`, `EAI_AGAIN`, `fetch failed`, `proxy error` fell through to default `refused`/`terminal`.
 * - User cancellations (`stream cancelled`, `session closed`) did the same.
 * Both are now `unverified` — the model was never really asked.
 */
export function classifyProbeError(error: unknown): { verdict: ProbeVerdict; detail: string; kind?: FailureKind } {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ((error as { message?: string })?.message ?? String(error))

  switch (classify(message)) {
    case 'withdrawn':
      return { verdict: 'refused', detail: message.slice(0, 200), kind: 'terminal' }
    case 'rejected':
      return { verdict: 'refused', detail: message.slice(0, 200), kind: 'rejected' }
    case 'rate_limited':
    case 'transport':
    case 'interrupted':
    case 'unavailable':
      // Never reached a verdict about the model. Folding these into `refused` is
      // how a model that answers every time gets reported dead and then dropped
      // from detection.
      return { verdict: 'unverified', detail: message.slice(0, 200) }
    default:
      // Unrecognised: default to a verdict on the model. A withdrawn model, an
      // unknown name, a request shape the provider will not accept. Kept, and
      // kept deliberately — a probe is direct evidence, so silence here is more
      // costly than an occasional wrong block.
      return { verdict: 'refused', detail: message.slice(0, 200), kind: 'terminal' }
  }
}

/** Runs one probe with a hard timeout, converting a timeout into `unverified`. */
async function runOne(
  role: RoleName,
  model: ModelRef,
  generate: GenerateLike,
  timeoutMs: number,
  now: () => number
): Promise<ProbeResult> {
  const started = now()
  const elapsed = () => now() - started

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`probe timed out after ${timeoutMs}ms`), { probeTimeout: true })),
        timeoutMs
      )
    })
    const result = await Promise.race([
      generate.text({
        prompt: PROBE_PROMPT,
        model: { providerID: model.providerID, id: model.id, variant: model.variant }
      }),
      timeout
    ])
    return {
      role,
      model,
      verdict: 'ok',
      // An empty body still counts as ok: reaching the provider is the whole question.
      detail: result?.text ? 'answered' : 'answered with an empty body',
      elapsedMs: elapsed()
    }
  } catch (error) {
    if ((error as { probeTimeout?: boolean })?.probeTimeout) {
      // Never reached the provider, so this says nothing about the model.
      return { role, model, verdict: 'unverified', detail: `no answer within ${timeoutMs}ms`, elapsedMs: elapsed() }
    }
    const classified = classifyProbeError(error)
    return { role, model, ...classified, elapsedMs: elapsed() }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Second attempt through a real session. The session is always removed: a half-used
 * one left behind shows up in the user's list as if it were work in progress.
 */
async function runViaSession(
  role: RoleName,
  model: ModelRef,
  session: SessionProbeLike,
  directory: string | undefined,
  timeoutMs: number,
  now: () => number
): Promise<ProbeResult> {
  const started = now()
  const elapsed = () => now() - started
  let sessionID: string | undefined
  try {
    // The location goes in with the create. Creating first and moving after is
    // the fix for a different bug in the wrong place: the session already exists
    // in the server's default directory, and prompting it boots that location.
    const created = await session.create({
      title: 'orchestra probe',
      ...(directory ? { location: { directory } } : {})
    })
    sessionID = created.id
    if (directory && created.location?.directory !== directory) {
      await session.move({ sessionID, directory })
    }
    await session.switchModel({ sessionID, model: { providerID: model.providerID, id: model.id } })
    await session.prompt({ sessionID, text: PROBE_PROMPT })
    // The turn is asynchronous: `prompt` admits the message and returns, so the
    // answer only exists once the session goes idle again.
    await session.wait({ sessionID })
    return { role, model, verdict: 'ok', detail: 'answered via a session', elapsedMs: elapsed() }
  } catch (error) {
    const classified = classifyProbeError(error)
    return {
      role,
      model,
      ...classified,
      detail: `${classified.detail} (via a session)`,
      elapsedMs: elapsed()
    }
  } finally {
    if (sessionID) await session.remove({ sessionID }).catch(() => undefined)
  }
}

export async function probeAssignments(input: ProbeInput): Promise<ProbeResult[]> {
  const { assignments, generate, session } = input
  const timeoutMs = input.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = input.options?.now ?? Date.now

  const roles: RoleName[] = [...ROLES]
  return Promise.all(
    roles.map(async role => {
      const model = assignments[role]
      if (!model) {
        return { role, verdict: 'unverified', detail: 'no model assigned to this role', elapsedMs: 0 } as ProbeResult
      }
      // No cheap route without `generate.text`: unverified, with the
      // capability in the detail. Deliberately not routed through
      // `classifyProbeError`, whose default branch is a verdict on the model.
      const first: ProbeResult = generate
        ? await runOne(role, model, generate, timeoutMs, now)
        : {
            role,
            model,
            verdict: 'unverified',
            detail: 'not verified: the host provides no generate.text (missing capability)',
            elapsedMs: 0
          }
      if (!session || first.verdict === 'ok') return first
      return runViaSession(role, model, session, input.directory, timeoutMs, now)
    })
  )
}

/** One line per role, for the report. */
export function describeProbe(result: ProbeResult): string {
  const ref = result.model ? `${result.model.providerID}/${result.model.id}` : 'no model'
  switch (result.verdict) {
    case 'ok':
      return `\`${ref}\` answered in ${result.elapsedMs}ms.`
    case 'refused':
      return `\`${ref}\` refused the request: ${result.detail}`
    default:
      return `\`${ref}\` was not verified: ${result.detail}`
  }
}

export function deadRoles(results: readonly ProbeResult[]): RoleName[] {
  return results.filter(result => result.verdict === 'refused').map(result => result.role)
}

export function suggestPin(results: readonly ProbeResult[], role: RoleName): string | undefined {
  const target = results.find(result => result.role === role)
  if (!target || target.verdict !== 'refused') return undefined
  const donor = results.find(result => result.role !== role && result.verdict === 'ok' && result.model)
  if (!donor?.model) return undefined
  return `"roles": { "${role}": "${donor.model.providerID}/${donor.model.id}" }`
}
