/**
 * Role resolution: scores the detected catalog for the three orchestra roles and
 * assigns exactly one model (plus reasoning variant) to each.
 *
 * Scoring is a weighted sum of normalized signals, so it works the same for a
 * Claude-heavy catalog, a local Ollama box, or a free-tier gateway. Assignment
 * then prefers distinct models per role and reuses a model only when the
 * catalog is too small to keep the roles separate.
 */

import { buildCandidates } from './infer'
import type {
  InferredSignal,
  ModelRef,
  PinSelector,
  ResolveInput,
  ResolveOutput,
  RoleAssignment,
  RoleName,
  ScoreEntry,
  Signals
} from './types'
import { ROLES } from './types'

export type Weights = {
  speed: number
  cheapness: number
  reasoning: number
  coding: number
  context: number
  outputLimit: number
  recency: number
}

/**
 * One step of a role's dispatch chain: a scored model, expanded far enough to
 * run a turn against it.
 *
 * Both halves are returned deliberately. The ref is what quarantine, the report
 * and the pin file talk in, so it is the comparison key; the expanded `ModelRef`
 * is what `session.switchModel` takes, including the reasoning variant this role
 * would otherwise pick, so a fallback turn runs under the same conditions as the
 * one it replaces rather than on a silently different budget.
 */
export interface RankedCandidate {
  /** `provider/model`. */
  ref: string
  /** Role-weighted score, so the chain can be walked in strict preference order. */
  score: number
  /** Expanded for dispatch, with the role's chosen reasoning variant. */
  model: ModelRef
}

/**
 * `ResolveOutput` plus the order the candidates were scored in.
 *
 * Declared here rather than in `src/types.ts` on purpose. `ResolveOutput` is the
 * shared contract for every reader of a resolution — report, pin file, plugin
 * state — and only dispatch cares about the ordering. Widening the shared type
 * would make all of them reason about a field they ignore. As a subtype with an
 * *optional* field it costs existing callers nothing.
 */
export interface ResolvedRoles extends ResolveOutput {
  /** Per-role scored order, best first. Absent on anything not built by `resolveRoles`. */
  ranked?: Partial<Record<RoleName, RankedCandidate[]>>
  /** Per-role variant overrides used during resolution (for fallbackChain). */
  variants?: Partial<Record<RoleName, string | null>>
}

/** Relative importance of each signal per role. Sums to 1. */
export const WEIGHTS: Record<RoleName, Weights> = {
  // The scout runs many small calls, so latency and price dominate.
  scout: {
    speed: 0.4,
    cheapness: 0.35,
    reasoning: 0.08,
    coding: 0.05,
    context: 0.04,
    outputLimit: 0.03,
    recency: 0.05
  },
  // The builder does the bulk of the work: coding fit, headroom, sane reasoning.
  builder: { speed: 0, cheapness: 0.1, reasoning: 0.22, coding: 0.3, context: 0.18, outputLimit: 0.12, recency: 0.08 },
  // The advisor never writes code, so depth wins over coding affinity and speed.
  advisor: {
    speed: 0.1,
    cheapness: 0.04,
    reasoning: 0.55,
    coding: 0.06,
    context: 0.1,
    outputLimit: 0.05,
    recency: 0.1
  },
  // The skeptic reasons about proposals rather than shipping them, so it is
  // weighted like the advisor but cheaper: one turn per `/panel`, not a standing
  // reviewer. `coding` is non-zero because it reads a diff and has to judge it,
  // not only prose.
  skeptic: {
    speed: 0.05,
    cheapness: 0.15,
    reasoning: 0.45,
    coding: 0.08,
    context: 0.12,
    outputLimit: 0.05,
    recency: 0.1
  }
}

const ROLE_LABEL: Record<RoleName, string> = {
  builder: 'Builder',
  scout: 'Scout',
  advisor: 'Advisor',
  skeptic: 'Skeptic'
}

/** Roles that carry the project's output; previews are discounted there. */
const MATURITY_PENALTY: Partial<Record<RoleName, number>> = { advisor: 0.88, builder: 0.93, skeptic: 0.88 }

export function score(signal: Signals, role: RoleName): number {
  const weight = WEIGHTS[role]
  // For advisor and builder a faster model is a worse trade, so speed is inverted.
  const latencyFit = role === 'scout' ? signal.speed : 1 - signal.speed
  const total =
    weight.speed * latencyFit +
    weight.cheapness * signal.cheapness +
    weight.reasoning * signal.reasoning +
    weight.coding * signal.coding +
    weight.context * signal.context +
    weight.outputLimit * signal.outputLimit +
    weight.recency * signal.recency
  const penalty = signal.experimental ? (MATURITY_PENALTY[role] ?? 1) : 1
  return Number((total * penalty).toFixed(4))
}

/** Highest-score candidate for a role, with deterministic tie-breaking. */
function rank(candidates: Signals[], role: RoleName): ScoreEntry[] {
  return candidates
    .map(model => ({ model, score: score(model, role) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.model.reasoning !== a.model.reasoning) return b.model.reasoning - a.model.reasoning
      if ((b.model.released ?? 0) !== (a.model.released ?? 0)) {
        return (b.model.released ?? 0) - (a.model.released ?? 0)
      }
      return a.model.ref.localeCompare(b.model.ref)
    })
}

/** Picks the reasoning variant that matches the role's cost/latency budget. */
export function chooseVariant(model: Signals, role: RoleName): string | undefined {
  const entries = Object.entries(model.variantEffort).filter(([, effort]) => effort > 0)
  if (!entries.length) return undefined
  entries.sort((a, b) => b[1] - a[1])
  if (role === 'advisor') return entries[0]![0]
  // The skeptic takes the second-highest effort when there is one, not the
  // highest. When a thin catalog forces it onto the advisor's model — the case
  // `/panel` warns about — running it at a different effort is the only
  // remaining hedge against two reviewers agreeing because they are literally
  // the same weights. Worth one notch of depth; not worth silently thinking
  // alike.
  if (role === 'skeptic') return entries.length > 1 ? entries[1]![0] : entries[0]![0]
  if (role === 'scout') return entries[entries.length - 1]![0]
  // Builder: prefer a mid effort setting, otherwise the middle of the range.
  const middle =
    entries.find(([, effort]) => effort >= 0.4 && effort <= 0.6) ?? entries[Math.floor((entries.length - 1) / 2)]
  return middle?.[0]
}

function formatPrice(model: Signals): string {
  if (!model.price) return 'price unknown'
  if (model.free) return 'free'
  return `$${model.price.input.toFixed(2)}/$${model.price.output.toFixed(2)} per Mtok`
}

function formatTokens(value: number | undefined): string {
  if (!value) return 'unknown'
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

/** Lead over the best of every other candidate on one signal. */
function marginOver(model: Signals, pool: Signals[], signal: keyof Signals): number {
  const value = model[signal] as number
  const others = pool.filter(other => other !== model).map(other => other[signal] as number)
  return others.length ? value - Math.max(...others) : value
}

/**
 * Marks a reason that rests on a family keyword rather than a catalog fact.
 *
 * Appended, not substituted: the reason is still true, it is just not a
 * measurement, and dropping it outright would leave the reader with no idea the
 * role was chosen on an adjective.
 */
const INFERRED = ' — inferred from the family name, not measured'

/** Short, concrete justification used in the report and the assignment notes. */
export function explain(model: Signals, role: RoleName, pool: Signals[], variantOverride?: string): string[] {
  const reasons: string[] = []
  const weight = WEIGHTS[role]
  const inferred = new Set(model.inferredSignals ?? [])
  const soft = (signal: InferredSignal) => inferred.has(signal)

  if (weight.cheapness > 0.2) {
    const cheapest = pool.every(other => (other.price?.input ?? 0) >= (model.price?.input ?? 0))
    reasons.push(model.free ? 'Free tier, so repeated scout calls cost nothing' : formatPrice(model))
    if (cheapest && !model.free) reasons.push('Cheapest model in the catalog')
  } else if (model.free) {
    reasons.push('Free tier, so it costs nothing to run')
  } else {
    reasons.push(formatPrice(model))
  }

  // Superlatives are only worth stating when the winner has a real margin.
  const reasoningMargin = marginOver(model, pool, 'reasoning')
  if (role === 'advisor' && reasoningMargin >= 0.15) {
    reasons.push(
      `Deepest reasoning headroom available (+${reasoningMargin.toFixed(2)})${soft('reasoning') ? INFERRED : ''}`
    )
  }
  const codingMargin = marginOver(model, pool, 'coding')
  if (role === 'builder' && codingMargin >= 0.15) {
    reasons.push(`Strongest coding fit in the catalog${soft('coding') ? INFERRED : ''}`)
  }
  const codeTags = model.tags.filter(tag => tag.startsWith('code:'))
  if (codeTags.length) reasons.push(`Coding family: ${codeTags.join(', ')}`)
  if (role === 'scout' && marginOver(model, pool, 'speed') >= 0.05) {
    reasons.push(`Fastest model available${soft('speed') ? INFERRED : ''}`)
  }

  const variant = variantOverride ?? chooseVariant(model, role)
  const effort = model.variantEffort[variant ?? '']
  reasons.push(
    variant
      ? effort !== undefined
        ? `Variant #${variant} (effort ${effort.toFixed(2)}${variantOverride ? ', forced' : ''})`
        : `Variant #${variant}${variantOverride ? ', forced by configuration' : ''}`
      : 'No reasoning variant exposed'
  )

  reasons.push(`${formatTokens(model.contextLimit)} context / ${formatTokens(model.outputLimitTokens)} output`)
  if (model.experimental) {
    reasons.push(`Pre-release family, discounted for roles that carry output${soft('experimental') ? INFERRED : ''}`)
  }
  if (model.tags.length) reasons.push(`Family hints: ${model.tags.slice(0, 3).join(', ')}`)
  if (model.vision) reasons.push('Accepts images')
  if (!model.tools) reasons.push('Tool support unverified')
  if (model.released) {
    reasons.push(`Released ${new Date(model.released).toISOString().slice(0, 10)}`)
  }
  return reasons
}

/**
 * Accepts every shape a role can be pinned with: `"provider/id#variant"`, the
 * expanded `{ providerID, id }` object, and the pin file's `{ model, variant }`.
 */
function toRef(selector: PinSelector, variant?: string): ModelRef {
  if (typeof selector === 'string') {
    const [path, hash] = selector.split('#')
    const index = path!.indexOf('/')
    const providerID = index === -1 ? '' : path!.slice(0, index)
    const id = index === -1 ? path! : path!.slice(index + 1)
    const resolved = variant ?? hash
    return resolved ? { providerID, id, variant: resolved } : { providerID, id }
  }
  const source = 'model' in selector ? selector.model : `${selector.providerID}/${selector.id}`
  const ref = toRef(source)
  const resolved = variant ?? selector.variant
  return resolved ? { ...ref, variant: resolved } : ref
}

function refKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}`
}

/**
 * Resolves the model for each role.
 *
 * Precedence: explicit overrides > pin file > detection. An override or pin
 * naming a model this project does not offer is reported and falls back to
 * detection, so a stale pin never leaves a role without one. The same for one
 * quarantine removed, as long as detection has something to offer.
 *
 * One case differs: a catalog quarantine has emptied, so "fall back to
 * detection" has nowhere to go and a pin naming a refused model is the only
 * instruction that produces one. That pin is honoured and the exclusion reported
 * — quarantine is outlived there, never side-stepped while an alternative exists.
 *
 * Also returns the per-role scored order, which used to be computed and thrown
 * away. It is the chain a dispatch walks when the picked model proves unusable.
 */
export function resolveRoles(input: ResolveInput): ResolvedRoles {
  const notes: string[] = []
  const exclude = new Set(input.exclude ?? [])
  const available = exclude.size
    ? input.catalog.filter(model => !exclude.has(`${model.providerID}/${model.id}`))
    : input.catalog
  const { candidates, notes: detectNotes } = buildCandidates(available, WEIGHTS.scout)
  notes.push(...detectNotes)
  if (exclude.size) {
    const dropped = [...exclude].filter(ref => input.catalog.some(model => `${model.providerID}/${model.id}` === ref))
    if (dropped.length)
      // The ref stays in the output. A bare reason is unreadable — "excluded:
      // free tier can only be used" says nothing about which model, and with two
      // models refused for the same reason the list is indistinguishable. The
      // reason goes alongside the name, never in place of it.
      notes.push(
        `Excluded ${dropped.length} model(s) that failed at request time: ${dropped
          .map(ref => {
            const reason = input.excludeReasons?.[ref]
            return reason ? `${ref} (${reason})` : ref
          })
          .join(', ')}.`
      )
  }

  const assignments = {} as Record<RoleName, RoleAssignment>
  const ranked = {
    builder: rank(candidates, 'builder'),
    scout: rank(candidates, 'scout'),
    advisor: rank(candidates, 'advisor'),
    skeptic: rank(candidates, 'skeptic')
  }
  // This map used to stop here: the order was computed, `runnersUp` took three
  // entries of it, and the rest was thrown away. A dispatch that fails has no
  // way to ask for the next-best model without it.
  const chain = (role: RoleName) => rankedChain(ranked[role], role)

  // The assignment a role gets when there is genuinely nothing left to put in
  // it: no model at all, so the agent inherits the session's. Two different
  // situations arrive here and the difference matters to whoever reads the
  // report: a project with no tool-capable model at all, and a project where
  // every model was excluded because this host was refused them. The second is a
  // runtime condition with a fix (pin a model), the first is a setup problem.
  const inherited = (role: RoleName): RoleAssignment => ({
    role,
    source: 'fallback',
    reasons:
      exclude.size > 0 && available.length === 0
        ? [
            `Every model this project can see was refused by the host (${exclude.size} excluded); ` +
              'this agent inherits the session model. Pin a model that answers to fix this.'
          ]
        : ['No tool-capable model available; this agent inherits the session model.'],
    runnersUp: []
  })

  /** Signals for a model this project offers, quarantine aside. */
  const offeredSignals = () => buildCandidates(input.catalog, WEIGHTS.scout).candidates

  /**
   * Signals for a model `selector` names that quarantine removed, if any.
   *
   * `candidates` cannot answer "was this model removed, or was it never
   * offered?" — both are simply absent from it. The unfiltered catalog can, and
   * only the first is something a rescue can act on.
   */
  const quarantined = (selector: PinSelector | null | undefined): { signals: Signals; ref: ModelRef } | undefined => {
    if (!selector) return undefined
    const ref = toRef(selector)
    const key = refKey(ref)
    if (!exclude.has(key)) return undefined
    if (!input.catalog.some(model => `${model.providerID}/${model.id}` === key)) return undefined
    const signals = offeredSignals().find(model => model.providerID === ref.providerID && model.id === ref.id)
    return signals ? { signals, ref } : undefined
  }

  const used = new Map<string, RoleName>()
  const variantOverrideFor = (role: RoleName): string | undefined => {
    const v = input.variants?.[role]
    return v === null ? undefined : v
  }
  const assign = (
    role: RoleName,
    model: Signals,
    source: RoleAssignment['source'],
    variantOverride?: string,
    reasons?: string[]
  ) => {
    const variant = variantOverride ?? chooseVariant(model, role)
    const key = model.ref
    assignments[role] = {
      role,
      model: variant
        ? { providerID: model.providerID, id: model.id, variant }
        : { providerID: model.providerID, id: model.id },
      source,
      reasons: reasons ?? explain(model, role, candidates, variantOverride),
      score: score(model, role),
      sharedWith: used.get(key) ? [used.get(key)!] : undefined,
      runnersUp: ranked[role].filter(entry => entry.model.ref !== key).slice(0, 3)
    }
    if (!used.has(key)) used.set(key, role)
    else {
      for (const [, other] of Object.entries(assignments) as [RoleName, RoleAssignment][]) {
        if (other.model && refKey(other.model) === key) {
          other.sharedWith = Array.from(new Set([...(other.sharedWith ?? []), role]))
        }
      }
    }
  }

  if (!candidates.length) {
    for (const role of ROLES) {
      // Quarantine wins over a pin, with exactly one exception: this branch,
      // where quarantine has taken every model and "fall back to detection" has
      // nothing left to fall back to. The report here tells the user to pin a
      // model that answers, and a pin naming a refused model is the only
      // instruction that can produce one — refusing it would leave the role on
      // the session model and make that advice impossible to follow.
      //
      // Wherever an alternative exists, detection still wins. Quarantine is
      // outlived here, not side-stepped, and that distinction is what keeps the
      // stale-pin rule intact in the ordinary case.
      const override = input.overrides?.[role]
      const rescued = quarantined(override) ?? quarantined(input.pins?.[role])
      if (!rescued) {
        assignments[role] = inherited(role)
        continue
      }
      const source = override ? 'override' : 'pin'
      const key = refKey(rescued.ref)
      const reason = input.excludeReasons?.[key]
      notes.push(
        `${ROLE_LABEL[role]} ${source} "${key}" was excluded by the host${reason ? ` (${reason})` : ''}, but ` +
          'nothing else is left, so it is used anyway. Pin another model if this one fails.'
      )
      const variantOverride = input.variants?.[role] ?? rescued.ref.variant
      assign(role, rescued.signals, source, variantOverride, [
        source === 'override'
          ? 'Forced by plugin options.'
          : 'Pinned in orchestra.json, so this role does not follow the catalog.',
        `Quarantined on this host${reason ? `: ${reason}` : ''}. Nothing else was left to use.`
      ])
    }
    return { candidates, assignments, notes, ranked: emptyRanked() }
  }

  const claim = (role: RoleName, selector: PinSelector | null | undefined, source: 'override' | 'pin'): boolean => {
    if (!selector) return false
    const ref = toRef(selector)
    const match = candidates.find(model => model.providerID === ref.providerID && model.id === ref.id)
    if (!match) {
      notes.push(
        `${ROLE_LABEL[role]} ${source} "${refKey(ref)}" is not available or has been quarantined; falling back to detection.`
      )
      return false
    }
    const variantOverride = input.variants?.[role] ?? ref.variant
    assign(role, match, source, variantOverride, [
      source === 'override'
        ? 'Forced by plugin options.'
        : 'Pinned in orchestra.json, so this role does not follow the catalog.',
      ...explain(match, role, candidates, variantOverride)
    ])
    return true
  }

  // Advisor first: it is the scarcest capability, so the builder and scout can
  // avoid it when the catalog has enough depth left. Plugin options beat the pin
  // file, which beats detection.
  if (!claim('advisor', input.overrides?.advisor, 'override')) claim('advisor', input.pins?.advisor, 'pin')
  if (!assignments.advisor) assign('advisor', ranked.advisor[0]!.model, 'detected', variantOverrideFor('advisor'))

  if (!claim('builder', input.overrides?.builder, 'override')) claim('builder', input.pins?.builder, 'pin')
  if (!assignments.builder) {
    const advisorKey = assignments.advisor?.model ? refKey(assignments.advisor.model) : undefined
    const spare = ranked.builder.find(entry => entry.model.ref !== advisorKey)
    assign(
      'builder',
      (spare ?? ranked.builder[0]!).model,
      spare ? 'detected' : 'fallback',
      variantOverrideFor('builder')
    )
  }

  if (!claim('scout', input.overrides?.scout, 'override')) claim('scout', input.pins?.scout, 'pin')
  if (!assignments.scout) {
    const taken = new Set(
      [assignments.advisor, assignments.builder]
        .map(entry => entry?.model)
        .filter((model): model is ModelRef => Boolean(model))
        .map(refKey)
    )
    const fresh = ranked.scout.find(entry => !taken.has(entry.model.ref))
    assign('scout', (fresh ?? ranked.scout[0]!).model, fresh ? 'detected' : 'fallback', variantOverrideFor('scout'))
  }

  // Skeptic last: it has the most freedom to move, because nothing downstream
  // depends on its pick and the roles it must avoid are all assigned by now.
  //
  // Two tiers of avoidance, because "different" is not equally good. Avoiding
  // the builder is mandatory — a skeptic on the builder's model reviews a
  // proposal with the weights that produced it, which is the correlation that
  // defeats the role. Avoiding the advisor and the scout is preferred but not
  // mandatory: sharing there is weaker (a different mandate, and against the
  // advisor a different reasoning effort), so it is allowed and reported rather
  // than blocked.
  //
  // Both tiers need every other role's ref. Avoiding only the builder left the
  // skeptic free to land on the advisor's or the scout's model, and in a catalog
  // where the roles rank identically — no distinguishing signal — it always did,
  // so two roles collided however the ordering was fixed.
  if (!claim('skeptic', input.overrides?.skeptic, 'override')) claim('skeptic', input.pins?.skeptic, 'pin')
  if (!assignments.skeptic) {
    const keyOf = (role: RoleName) => {
      const model = assignments[role]?.model
      return model ? refKey(model) : undefined
    }
    const builderKey = keyOf('builder')
    const taken = new Set([builderKey, keyOf('advisor'), keyOf('scout')].filter((key): key is string => Boolean(key)))
    const independent = ranked.skeptic.find(entry => !taken.has(entry.model.ref))
    const distinctFromBuilder = independent ?? ranked.skeptic.find(entry => entry.model.ref !== builderKey)
    if (independent) {
      assign('skeptic', independent.model, 'detected', variantOverrideFor('skeptic'))
    } else if (distinctFromBuilder) {
      // Available, but it forces the skeptic onto a model another role holds.
      assign('skeptic', distinctFromBuilder.model, 'detected', variantOverrideFor('skeptic'))
      const collided = refKey(distinctFromBuilder.model)
      const partner = assignments.advisor?.model && refKey(assignments.advisor.model) === collided ? 'advisor' : 'scout'
      notes.push(
        `${ROLE_LABEL.skeptic} shares a model with ${ROLE_LABEL[partner]} (${collided}): this catalog has ` +
          'nothing left outside it. Different mandates and reasoning settings, but the same weights — read the ' +
          'two verdicts as correlated.'
      )
    } else {
      // Nothing outside the builder's model. Take the best available and say so.
      assign('skeptic', ranked.skeptic[0]!.model, 'fallback', variantOverrideFor('skeptic'))
      notes.push(
        `${ROLE_LABEL.skeptic} shares a model with ${ROLE_LABEL.builder}: this catalog has no candidate ` +
          "outside the builder's. A panel whose skeptic is the builder is a second opinion from the same " +
          'weights, so treat its VERDICT as weaker than it reads.'
      )
    }
  }

  const reused = Object.values(assignments).filter(entry => entry.sharedWith?.length)
  if (reused.length) {
    const count = candidates.length
    // `ROLES.length`, not a literal. The number this compares against is the
    // number of roles that want a model, so hardcoding it silently understates
    // every warning the moment a role is added.
    notes.push(
      count < ROLES.length
        ? `Only ${count} tool-capable model(s) available; roles share a model.`
        : 'Not enough distinct depth, so at least two roles share a model.'
    )
  }

  return {
    candidates,
    assignments,
    notes,
    ranked: {
      builder: chain('builder'),
      scout: chain('scout'),
      advisor: chain('advisor'),
      skeptic: chain('skeptic')
    },
    variants: input.variants
  }
}

/**
 * Every role scored to nothing.
 *
 * Built from `ROLES` rather than written out, because this is the one shape that
 * a new role silently misses: a literal `{ builder: [], scout: [], advisor: [] }`
 * still type-checks when `skeptic` is absent (the field is optional), so the
 * omission compiles and only shows up as an empty fallback chain at dispatch.
 */
function emptyRanked(): ResolvedRoles['ranked'] {
  return Object.fromEntries(ROLES.map(role => [role, []])) as ResolvedRoles['ranked']
}

/**
 * Flattens one role's scored order into dispatchable steps.
 *
 * A module-level helper rather than an inline lambda so the return type is
 * stated once, next to the shape it produces.
 */
function rankedChain(entries: ScoreEntry[], role: RoleName): RankedCandidate[] {
  return entries.map(entry => {
    const variant = chooseVariant(entry.model, role)
    return {
      ref: entry.model.ref,
      score: entry.score,
      model: variant
        ? { providerID: entry.model.providerID, id: entry.model.id, variant }
        : { providerID: entry.model.providerID, id: entry.model.id }
    }
  })
}

/**
 * The models a dispatch for `role` may run on, best first.
 *
 * Three things make this more than "the ranked list":
 *
 * - It starts from the role's *assignment*, not always rank 1. The resolver moves
 *   a role off the top-scoring model to keep roles on distinct models, so a chain
 *   opening at rank 1 would start a scout on the advisor's model and report a move
 *   nobody made.
 * - `skip` removes models quarantine knows about. Blocked and rejected both go in
 *   and mean different things — gone vs refused by this transport — but neither
 *   can produce a turn here, and a rejected model is still visible to detection
 *   and in the report. Skipping it for dispatch is the difference between a
 *   fallback that works and one that walks into the same refusal.
 * - A candidate another role holds is *not* skipped. With a thin catalog that
 *   overlap is the reason a chain exists, and `sharedWith` already reports it.
 */
export function fallbackChain(
  resolved: ResolvedRoles,
  role: RoleName,
  skip: readonly string[] = []
): RankedCandidate[] {
  const skipRefs = new Set(skip)
  const seen = new Set<string>()
  const chain: RankedCandidate[] = []
  const variantOverride = resolved.variants?.[role]

  const push = (candidate: RankedCandidate) => {
    if (skipRefs.has(candidate.ref) || seen.has(candidate.ref)) return
    seen.add(candidate.ref)
    chain.push(candidate)
  }

  const ordered = resolved.ranked?.[role] ?? []
  const assigned = resolved.assignments[role]?.model
  if (assigned) {
    const key = refKey(assigned)
    push({
      ref: key,
      score: ordered.find(candidate => candidate.ref === key)?.score ?? resolved.assignments[role]?.score ?? 0,
      model: assigned
    })
  }
  for (const candidate of ordered) {
    // Apply variant override to fallback candidates if specified
    if (variantOverride !== undefined) {
      push({
        ...candidate,
        model: variantOverride
          ? { providerID: candidate.model.providerID, id: candidate.model.id, variant: variantOverride }
          : { providerID: candidate.model.providerID, id: candidate.model.id }
      })
    } else {
      push(candidate)
    }
  }
  return chain
}
