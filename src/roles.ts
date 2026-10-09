/**
 * Role resolution: scores the detected catalog for the three orchestra roles and
 * assigns exactly one model (plus reasoning variant) to each.
 *
 * Scoring is a weighted sum of normalized signals, so it works the same for a
 * Claude-heavy catalog, a local Ollama box, or a free-tier gateway. Assignment
 * then prefers distinct models per role and reuses a model only when the
 * catalog is too small to keep the roles separate.
 */

import { buildCandidates } from "./infer"
import type {
  ModelRef,
  PinSelector,
  ResolveInput,
  ResolveOutput,
  RoleAssignment,
  RoleName,
  ScoreEntry,
  Signals,
} from "./types"

export type Weights = {
  speed: number
  cheapness: number
  reasoning: number
  coding: number
  context: number
  outputLimit: number
  recency: number
}

/** Relative importance of each signal per role. Sums to 1. */
export const WEIGHTS: Record<RoleName, Weights> = {
  // The scout runs many small calls, so latency and price dominate.
  scout: { speed: 0.4, cheapness: 0.35, reasoning: 0.08, coding: 0.05, context: 0.04, outputLimit: 0.03, recency: 0.05 },
  // The builder does the bulk of the work: coding fit, headroom, sane reasoning.
  builder: { speed: 0, cheapness: 0.1, reasoning: 0.22, coding: 0.3, context: 0.18, outputLimit: 0.12, recency: 0.08 },
  // The advisor never writes code, so depth wins over coding affinity and speed.
  advisor: { speed: 0.1, cheapness: 0.04, reasoning: 0.55, coding: 0.06, context: 0.1, outputLimit: 0.05, recency: 0.1 },
}

const ROLE_LABEL: Record<RoleName, string> = {
  builder: "Builder",
  scout: "Scout",
  advisor: "Advisor",
}

/** Roles that carry the project's output; previews are discounted there. */
const MATURITY_PENALTY: Partial<Record<RoleName, number>> = { advisor: 0.88, builder: 0.93 }

export function score(signal: Signals, role: RoleName): number {
  const weight = WEIGHTS[role]
  // For advisor and builder a faster model is a worse trade, so speed is inverted.
  const latencyFit = role === "scout" ? signal.speed : 1 - signal.speed
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
    .map((model) => ({ model, score: score(model, role) }))
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
  if (role === "advisor") return entries[0]![0]
  if (role === "scout") return entries[entries.length - 1]![0]
  // Builder: prefer a mid effort setting, otherwise the middle of the range.
  const middle = entries.find(([, effort]) => effort >= 0.4 && effort <= 0.6) ?? entries[Math.floor((entries.length - 1) / 2)]
  return middle?.[0]
}

function formatPrice(model: Signals): string {
  if (!model.price) return "price unknown"
  if (model.free) return "free"
  return `$${model.price.input.toFixed(2)}/$${model.price.output.toFixed(2)} per Mtok`
}

function formatTokens(value: number | undefined): string {
  if (!value) return "unknown"
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

/** Lead over the best of every other candidate on one signal. */
function marginOver(model: Signals, pool: Signals[], signal: keyof Signals): number {
  const value = model[signal] as number
  const others = pool.filter((other) => other !== model).map((other) => other[signal] as number)
  return others.length ? value - Math.max(...others) : value
}

/** Short, concrete justification used in the report and the assignment notes. */
export function explain(
  model: Signals,
  role: RoleName,
  pool: Signals[],
  variantOverride?: string,
): string[] {
  const reasons: string[] = []
  const weight = WEIGHTS[role]

  if (weight.cheapness > 0.2) {
    const cheapest = pool.every((other) => (other.price?.input ?? 0) >= (model.price?.input ?? 0))
    reasons.push(
      model.free ? "Free tier, so repeated scout calls cost nothing" : formatPrice(model),
    )
    if (cheapest && !model.free) reasons.push("Cheapest model in the catalog")
  } else if (model.free) {
    reasons.push("Free tier, so it costs nothing to run")
  } else {
    reasons.push(formatPrice(model))
  }

  // Superlatives are only worth stating when the winner has a real margin.
  const reasoningMargin = marginOver(model, pool, "reasoning")
  if (role === "advisor" && reasoningMargin >= 0.15) {
    reasons.push(`Deepest reasoning headroom available (+${reasoningMargin.toFixed(2)})`)
  }
  const codingMargin = marginOver(model, pool, "coding")
  if (role === "builder" && codingMargin >= 0.15) reasons.push("Strongest coding fit in the catalog")
  const codeTags = model.tags.filter((tag) => tag.startsWith("code:"))
  if (codeTags.length) reasons.push(`Coding family: ${codeTags.join(", ")}`)
  if (role === "scout" && marginOver(model, pool, "speed") >= 0.05) reasons.push("Fastest model available")

  const variant = variantOverride ?? chooseVariant(model, role)
  const effort = model.variantEffort[variant ?? ""]
  reasons.push(
    variant
      ? effort !== undefined
        ? `Variant #${variant} (effort ${effort.toFixed(2)}${variantOverride ? ", forced" : ""})`
        : `Variant #${variant}${variantOverride ? ", forced by configuration" : ""}`
      : "No reasoning variant exposed",
  )

  reasons.push(`${formatTokens(model.contextLimit)} context / ${formatTokens(model.outputLimitTokens)} output`)
if (model.experimental) reasons.push("Pre-release family, discounted for roles that carry output")
  if (model.tags.length) reasons.push(`Family hints: ${model.tags.slice(0, 3).join(", ")}`)
  if (model.vision) reasons.push("Accepts images")
  if (!model.tools) reasons.push("Tool support unverified")
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
  if (typeof selector === "string") {
    const [path, hash] = selector.split("#")
    const index = path!.indexOf("/")
    const providerID = index === -1 ? "" : path!.slice(0, index)
    const id = index === -1 ? path! : path!.slice(index + 1)
    const resolved = variant ?? hash
    return resolved ? { providerID, id, variant: resolved } : { providerID, id }
  }
  const source = "model" in selector ? selector.model : `${selector.providerID}/${selector.id}`
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
 * Precedence: explicit overrides > pin file > detection. An override or pin that
 * points at an unavailable model is reported and falls back to detection, so a
 * stale pin never leaves a role without a model.
 */
export function resolveRoles(input: ResolveInput): ResolveOutput {
  const notes: string[] = []
  const exclude = new Set(input.exclude ?? [])
  const available = exclude.size ? input.catalog.filter((model) => !exclude.has(`${model.providerID}/${model.id}`)) : input.catalog
  const { candidates, notes: detectNotes } = buildCandidates(available)
  notes.push(...detectNotes)
  if (exclude.size) {
    const dropped = [...exclude].filter((ref) => input.catalog.some((model) => `${model.providerID}/${model.id}` === ref))
    if (dropped.length) notes.push(`Excluded ${dropped.length} model(s) that failed at request time: ${dropped.join(", ")}.`)
  }

  const assignments = {} as Record<RoleName, RoleAssignment>
  const ranked = {
    builder: rank(candidates, "builder"),
    scout: rank(candidates, "scout"),
    advisor: rank(candidates, "advisor"),
  }

  if (!candidates.length) {
    for (const role of ["builder", "scout", "advisor"] as RoleName[]) {
      assignments[role] = {
        role,
        source: "fallback",
        reasons: ["No tool-capable model available; this agent inherits the session model."],
        runnersUp: [],
      }
    }
    return { candidates, assignments, notes }
  }

  const used = new Map<string, RoleName>()
  const assign = (
    role: RoleName,
    model: Signals,
    source: RoleAssignment["source"],
    variantOverride?: string,
    reasons?: string[],
  ) => {
    const variant = variantOverride ?? chooseVariant(model, role)
    const key = model.ref
    assignments[role] = {
      role,
      model: variant ? { providerID: model.providerID, id: model.id, variant } : { providerID: model.providerID, id: model.id },
      source,
      reasons: reasons ?? explain(model, role, candidates, variantOverride),
      score: score(model, role),
      sharedWith: used.get(key) ? [used.get(key)!] : undefined,
      runnersUp: ranked[role].filter((entry) => entry.model.ref !== key).slice(0, 3),
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

  const claim = (role: RoleName, selector: PinSelector | null | undefined, source: "override" | "pin"): boolean => {
    if (!selector) return false
    const ref = toRef(selector)
    const match = candidates.find((model) => model.providerID === ref.providerID && model.id === ref.id)
    if (!match) {
      notes.push(
        `${ROLE_LABEL[role]} ${source} "${refKey(ref)}" is not available or has been quarantined; falling back to detection.`,
      )
      return false
    }
    assign(role, match, source, ref.variant, [
      source === "override"
        ? "Forced by plugin options."
        : "Pinned in orchestra.json, so this role does not follow the catalog.",
      ...explain(match, role, candidates, ref.variant),
    ])
    return true
  }

  // Advisor first: it is the scarcest capability, so the builder and scout can
  // avoid it when the catalog has enough depth left. Plugin options beat the pin
  // file, which beats detection.
  if (!claim("advisor", input.overrides?.advisor, "override")) claim("advisor", input.pins?.advisor, "pin")
  if (!assignments.advisor) assign("advisor", ranked.advisor[0]!.model, "detected")

  if (!claim("builder", input.overrides?.builder, "override")) claim("builder", input.pins?.builder, "pin")
  if (!assignments.builder) {
    const advisorKey = assignments.advisor?.model ? refKey(assignments.advisor.model) : undefined
    const spare = ranked.builder.find((entry) => entry.model.ref !== advisorKey)
    assign("builder", (spare ?? ranked.builder[0]!).model, spare ? "detected" : "fallback")
  }

  if (!claim("scout", input.overrides?.scout, "override")) claim("scout", input.pins?.scout, "pin")
  if (!assignments.scout) {
    const taken = new Set(
      [assignments.advisor, assignments.builder]
        .map((entry) => entry?.model)
        .filter((model): model is ModelRef => Boolean(model))
        .map(refKey),
    )
    const fresh = ranked.scout.find((entry) => !taken.has(entry.model.ref))
    assign("scout", (fresh ?? ranked.scout[0]!).model, fresh ? "detected" : "fallback")
  }

  const reused = Object.values(assignments).filter((entry) => entry.sharedWith?.length)
  if (reused.length) {
    const count = candidates.length
    notes.push(
      count < 3
        ? `Only ${count} tool-capable model(s) available; roles share a model.`
        : "Not enough distinct depth, so at least two roles share a model.",
    )
  }

  return { candidates, assignments, notes }
}