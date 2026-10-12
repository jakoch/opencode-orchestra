/**
 * Shared types for the orchestra role resolver.
 *
 * The shapes mirror the fields OpenCode exposes on `Model.Info`, but are kept
 * structural and permissive so the resolver can run against a raw catalog, an
 * API snapshot, or a test fixture without pulling in `@opencode/plugin`.
 */

export type RoleName = 'builder' | 'scout' | 'advisor' | 'skeptic'

export const ROLES: readonly RoleName[] = ['builder', 'scout', 'advisor', 'skeptic'] as const

/** `provider/model` plus optional `#variant`, or the expanded form. */
export type ModelSelector = string | { providerID: string; id: string; variant?: string }

/** Pin-file shape: `{ "model": "provider/id", "variant": "high" }`. */
export type PinSelector = ModelSelector | { model: string; variant?: string }

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface ModelCostTier {
  input: number
  output: number
  cache?: { read: number; write: number }
}

export interface ModelVariant {
  id: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

export interface ModelInfo {
  id: string
  modelID?: string
  providerID: string
  name: string
  family?: string
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
  variants?: ModelVariant[]
  time?: { released?: number }
  cost?: ModelCostTier[]
  status?: string
  enabled?: boolean
  limit?: { context?: number; output?: number }
  settings?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * The signals `infer.ts` can only derive from a model's name.
 *
 * Every other signal on `Signals` is a catalog fact — a price, a limit, a
 * release date, a declared variant — and can be checked against the provider's
 * own API. These four cannot, which is why a reason resting on one is labelled
 * rather than asserted.
 */
export type InferredSignal = 'speed' | 'reasoning' | 'coding' | 'experimental'

/** A candidate model plus the inferred capabilities the scorer works on. */
export interface Signals {
  ref: string
  providerID: string
  id: string
  name: string
  /** True when the model can drive tools, which every role requires. */
  tools: boolean
  vision: boolean
  /** Cheapest usable tier, in USD per million tokens. `null` when unknown. */
  price: { input: number; output: number } | null
  free: boolean
  /** 0..1 within the candidate set: higher means cheaper. */
  cheapness: number
  /** 0..1 within the candidate set: higher means more headroom. */
  context: number
  outputLimit: number
  /** 0..1 within the candidate set: higher means newer. */
  recency: number
  /** 0..1 absolute: declared or keyword-derived reasoning depth. */
  reasoning: number
  /** 0..1 absolute: declared or keyword-derived latency. */
  speed: number
  /** 0..1 absolute: keyword-derived coding affinity. */
  coding: number
  /** True for previews, alphas and betas: usable, but not what you bet on. */
  experimental: boolean
  /** Highest declared reasoning effort per variant id, 0..1. */
  variantEffort: Record<string, number>
  /** Keyword families that fired, for explainable output. */
  tags: string[]
  /**
   * Which of this model's signals came from family keywords rather than catalog
   * facts.
   *
   * A name is not a measurement: nothing in the catalog says `flash` is fast.
   * The score is still useful — an unbranded model has nothing else to rank on
   * — but a report printing "Fastest model available" beside a measured price
   * is mixing two kinds of fact. Listed so `explain()` can qualify the reasons
   * that rest on them.
   */
  inferredSignals: InferredSignal[]
  /**
   * The catalog's own family label, when it publishes one.
   *
   * Distinct from `tags`: a tag is a name keyword, and two unrelated models can
   * share one by coincidence. `family` is the provider's own grouping, so "every
   * role landed in one family" is a fact rather than an inference from a word in
   * a string. `undefined` when the catalog publishes nothing.
   */
  family?: string
  released?: number
  contextLimit?: number
  outputLimitTokens?: number
}

export interface ScoreEntry {
  model: Signals
  score: number
}

export interface RoleAssignment {
  role: RoleName
  /** Absent only when no tool-capable model is available in the project. */
  model?: ModelRef
  /** Where the decision came from: explicit config, pin file, or detection. */
  source: 'override' | 'pin' | 'detected' | 'fallback'
  /**
   * Whether a real request has confirmed this model answers.
   *
   * `unknown` is the default and the important case: the catalog says a model is
   * active, but nothing has asked it. That is not the same as healthy — and the
   * gap is what made this failure invisible, with `/orchestra` printing
   * "detected" for a model that refused every call.
   */
  verification?: 'verified' | 'refused' | 'unknown'
  reasons: string[]
  score?: number
  /** Set when another role resolved to the same model. */
  sharedWith?: RoleName[]
  /** Best alternatives, so the report can show what was passed over. */
  runnersUp: ScoreEntry[]
}

export interface ResolveInput {
  catalog: ModelInfo[]
  /** Explicit role overrides, e.g. from plugin options. */
  overrides?: Partial<Record<RoleName, ModelSelector | null>>
  /** Pinned role assignments, e.g. from `.opencode/orchestra.json`. */
  pins?: Partial<Record<RoleName, PinSelector | null>>
  /** Per-role variant overrides: string = force variant, null = no variant. */
  variants?: Partial<Record<RoleName, string | null>>
  /** `provider/model` refs to skip, e.g. models that failed at request time. */
  exclude?: readonly string[]
  /**
   * Why each excluded ref is excluded, keyed by ref.
   *
   * Cosmetic: it changes the note the report prints, nothing else. A model this
   * host refuses is a different problem from one the provider withdrew, and
   * collapsing the two into "unavailable" is what makes a detection failure look
   * like a configuration mistake.
   */
  excludeReasons?: Readonly<Record<string, string>>
}

export interface ResolveOutput {
  candidates: Signals[]
  assignments: Record<RoleName, RoleAssignment>
  /** Human-readable notes about catalog filtering and fallbacks. */
  notes: string[]
}

/**
 * The handoff envelope both read-only roles return.
 *
 * Replies are prose today, so the only way to consume one is to parse it. These
 * four fields are named in `SCOUT_SYSTEM` and `ADVISOR_SYSTEM`. All sections are
 * optional: a role with no open questions omits that section rather than padding
 * it.
 *
 * **What TypeScript bounds.** `confidence` is a closed union and `filesTouched`
 * is a template-literal type, so both are checked at compile time. TypeScript
 * cannot express a max length, so the caps below are documentation only. Nothing
 * may be built that treats them as validated.
 *
 * **Not parsed.** No code reads a reply into this shape. That is deliberate: a
 * parser that fails on a malformed return is a new failure mode, and a prompt is
 * a contract with a soft edge.
 */
export const HANDOFF_LIMITS = {
  /** `path:line` references in the FILES section. */
  maxFiles: 8,
  /** One finding per line: a scout location, or an advisor bullet. */
  maxFindings: 5,
  /** Past this the section stops being scannable, so the rest is dropped. */
  maxOpenQuestions: 3
} as const

/** The three words the prompts ask for. Anything else is not a confidence. */
export const HANDOFF_CONFIDENCE = ['high', 'medium', 'low'] as const

export type HandoffConfidence = (typeof HANDOFF_CONFIDENCE)[number]

/** `path:line`. The shape is enforced here; the length is not checkable. */
export type FileRef = `${string}:${number}`

export interface HandoffEnvelope {
  /** One line each: the conclusion, and what backs it. */
  findings: string[]
  /** The locations a consumer can open without re-reading the prose. */
  filesTouched: FileRef[]
  /** The producer's own read on how settled this is — not a quality score. */
  confidence: HandoffConfidence
  /** What the producer could not settle, and what would settle it. */
  openQuestions: string[]
}

/**
 * One advisory claim: what a role said, where it points, what backs it.
 *
 * A reference, never a copy. A consumer can act without re-reading the reply:
 * `claim` is one line, `refs` are locations, `command` names the check. A field
 * carrying output would be a transcript, and that is what makes a handoff
 * expensive.
 *
 * No producer `confidence`: it grades how settled the producer felt, which is
 * its own judgement. Support is what a consumer can act on.
 */
export interface Claim {
  /** Who made it. Provenance decides who can settle it (`docs/roles.md`). */
  role: RoleName
  /** The conclusion, in one line. Truncated by the recorder, not the caller. */
  claim: string
  /** `path:line` locations the claim rests on. */
  refs?: FileRef[]
  /**
   * The verification command, when the claim rests on one.
   */
  command?: string
}

/**
 * How far a claim is backed, strongest first.
 *
 * None is a verdict that the claim is *true*, and none gates anything. The
 * read-only roles cannot run a check (`docs/roles.md`), so the strongest thing
 * available is a run this session recorded; past that, a location a reader can
 * open.
 */
export type ClaimSupport =
  /** The store saw the cited command run, after the last write. */
  | 'observed'
  /** It rests on a `path:line` a reader can open: a location, not a result. */
  | 'referenced'
  /** Nothing recorded in this session backs it. A gap in the report, not a failure. */
  | 'unbacked'
