/**
 * Shared types for the orchestra role resolver.
 *
 * The shapes mirror the fields OpenCode exposes on `Model.Info`, but are kept
 * structural and permissive so the resolver can run against a raw catalog, an
 * API snapshot, or a test fixture without pulling in `@opencode/plugin`.
 */

export type RoleName = "builder" | "scout" | "advisor"

export const ROLES: readonly RoleName[] = ["builder", "scout", "advisor"] as const

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
  source: "override" | "pin" | "detected" | "fallback"
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
  /** `provider/model` refs to skip, e.g. models that failed at request time. */
  exclude?: readonly string[]
}

export interface ResolveOutput {
  candidates: Signals[]
  assignments: Record<RoleName, RoleAssignment>
  /** Human-readable notes about catalog filtering and fallbacks. */
  notes: string[]
}