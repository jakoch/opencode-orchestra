/**
 * Capability inference.
 *
 * OpenCode's catalog carries price, limits, release date and declared reasoning
 * variants. It does not carry "is this model fast" or "is this model a coder".
 * This module derives those signals from catalog facts plus family keywords, so
 * the role scorer has something to rank on for any provider, local or hosted.
 *
 * Every heuristic here is deliberately explainable: `tags` records which family
 * fired so the report can say *why* a model was picked instead of just ranking.
 */

import type { ModelInfo, ModelVariant, Signals } from "./types"

/** Latency family keywords. Cheaper/faster tiers usually carry one of these. */
const SPEED_WORDS = [
  "flash",
  "lightning",
  "instant",
  "turbo",
  "haiku",
  "mini",
  "lite",
  "nano",
  "swift",
  "fast",
  "quick",
  "small",
  "tiny",
  "air",
]

/** Reasoning family keywords, ordered from strongest signal to weakest. */
const REASONING_WORDS: [string, number][] = [
  ["opus", 0.95],
  ["ultra", 0.9],
  ["max", 0.85],
  ["thinking", 0.85],
  ["thinker", 0.85],
  ["deep", 0.8],
  ["reason", 0.8],
  ["frontier", 0.9],
  ["xhigh", 0.9],
  ["gpt-5", 0.75],
  ["step-", 0.75],
  ["o1", 0.7],
  ["o3", 0.75],
  ["o4", 0.8],
  ["r1", 0.7],
  ["pro", 0.65],
]

/** Coding family keywords. */
const CODING_WORDS: [string, number][] = [
  ["coder", 0.95],
  ["code", 0.9],
  ["sonnet", 0.8],
  ["swe", 0.75],
  ["dev", 0.7],
  ["patch", 0.7],
  ["ide", 0.65],
  ["engineer", 0.7],
]

/** Named reasoning effort levels, used for variant selection. */
const EFFORT_WORDS: [string, number][] = [
  ["minimal", 0.05],
  ["min", 0.05],
  ["none", 0],
  ["off", 0],
  ["low", 0.25],
  ["medium", 0.5],
  ["med", 0.5],
  ["default", 0.5],
  ["balanced", 0.5],
  ["standard", 0.5],
  ["high", 0.75],
  ["xhigh", 0.9],
  ["extra-high", 0.9],
  ["very-high", 0.9],
  ["max", 1],
  ["maximum", 1],
  ["ultra", 1],
]

/** Settings keys that expose reasoning effort, in provider dialects. */
const EFFORT_KEYS = [
  "reasoningEffort",
  "reasoning_effort",
  "reasoning",
  "effort",
  "thinking",
  "thinkingBudget",
  "reasoningBudget",
  "budget_tokens",
  "budgetTokens",
]

/** Pre-release families: fine for scouting, risky as the model you trust. */
const PREVIEW_WORDS = ["alpha", "preview", "beta", "experimental", "-rc", "nightly", "dev"]

const DEAD_STATUSES = new Set(["deprecated", "retired", "discontinued", "dead"])

/** Models we can never rank: no tool calling means no agent. */
export function isUsable(model: ModelInfo): boolean {
  if (model.enabled === false) return false
  if (model.status && DEAD_STATUSES.has(model.status)) return false
  if (model.capabilities?.tools === false) return false
  return true
}

function haystack(model: ModelInfo): string {
  return `${model.id} ${model.modelID ?? ""} ${model.name} ${model.family ?? ""}`.toLowerCase()
}

function matchWords(text: string, table: [string, number][]): { value: number; words: string[] } {
  let value = 0
  const words: string[] = []
  for (const [word, weight] of table) {
    if (!text.includes(word)) continue
    words.push(word)
    value = Math.max(value, weight)
  }
  return { value, words }
}

/** Maps a variant's declared settings to a 0..1 reasoning effort score. */
export function variantEffort(variant: ModelVariant): number {
  const settings = variant.settings ?? {}
  for (const key of EFFORT_KEYS) {
    const raw = settings[key]
    if (typeof raw === "number" && raw > 0) {
      // Token budgets: 1k is minimal, 64k+ is maximum.
      return clamp01(Math.log10(Math.max(raw, 100)) / Math.log10(64_000))
    }
    if (typeof raw === "string") {
      const effort = effortFromWord(raw)
      if (effort !== undefined) return effort
    }
    if (typeof raw === "boolean") return raw ? 0.75 : 0
  }
  const fromId = effortFromWord(variant.id)
  if (fromId !== undefined) return fromId
  const body = (variant.body ?? {}) as Record<string, unknown>
  for (const key of EFFORT_KEYS) {
    const raw = body[key]
    if (typeof raw === "string") {
      const effort = effortFromWord(raw)
      if (effort !== undefined) return effort
    }
  }
  return 0
}

export function effortFromWord(word: string): number | undefined {
  const normalized = word.trim().toLowerCase()
  for (const [needle, value] of EFFORT_WORDS) {
    if (normalized === needle || normalized.endsWith(`-${needle}`) || normalized.endsWith(`_${needle}`)) {
      return value
    }
  }
  return undefined
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Min-max normalization on a log scale; equal inputs land in the middle. */
function normalizeLog(values: number[]): number[] {
  const logs = values.map((value) => Math.log10(Math.max(value, 1)))
  const min = Math.min(...logs)
  const max = Math.max(...logs)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
    return logs.map(() => (logs.length > 1 ? 0.5 : 0))
  }
  return logs.map((value) => (value - min) / (max - min))
}

/**
 * Cheapest tier a session would realistically use.
 *
 * Providers publish one tier per context band, priced by how much context you
 * hold. A scout fills a fraction of the window while a builder can fill a lot,
 * so the first (cheapest) tier is the honest comparison point: it is what the
 * common case costs. Comparing the whole ladder would rank a model by its
 * long-context tier, which nothing here ever pays.
 */
function usableTier(model: ModelInfo) {
  const tiers = model.cost ?? []
  if (!tiers.length) return null
  return tiers.reduce(
    (best, tier) => (tier.input + tier.output < best.input + best.output ? tier : best),
    tiers[0]!,
  )
}

/**
 * Builds scored candidates from a raw catalog. Set-relative signals (price,
 * context, output limit, recency) are normalized inside this function so the
 * result adapts to whatever catalog the project actually has.
 */
export function buildCandidates(catalog: ModelInfo[]): { candidates: Signals[]; notes: string[] } {
  const notes: string[] = []
  const usable = catalog.filter(isUsable)
  const dropped = catalog.length - usable.length
  if (dropped > 0) notes.push(`Filtered out ${dropped} model(s) without tool support or with a dead status.`)
  if (!usable.length) {
    notes.push("No tool-capable model is available in this project.")
    return { candidates: [], notes }
  }

  const texts = usable.map(haystack)
  const priced = usable.filter((model) => (model.cost?.length ?? 0) > 0)
  const prices = usable.map((model) => {
    const tier = usableTier(model)
    return tier ? tier.input + tier.output : 0
  })
  const knownPrice = prices.some((price) => price > 0)
  // `priceRank` is 1 for the most expensive model in the set; cheapness is its
  // mirror image, so a free local model always outranks a frontier model there.
  const priceRank = normalizeLog(prices.map((price) => (knownPrice ? Math.max(price, 0.1) : 0.1)))
  const cheapnessScores = priceRank.map((rank) => 1 - rank)
  const contextScores = normalizeLog(usable.map((model) => model.limit?.context ?? 0))
  const outputScores = normalizeLog(usable.map((model) => model.limit?.output ?? 0))
  const releases = usable.map((model) => model.time?.released ?? 0)
  const recencyScores = normalizeLog(releases.map((release) => release || 1))

  const candidates: Signals[] = usable.map((model, index) => {
    const text = texts[index]!
    const tier = usableTier(model)
    const price = tier ? { input: tier.input, output: tier.output } : null
    const free = price !== null && price.input + price.output <= 0
    const variants = model.variants ?? []
    const variantEfforts: Record<string, number> = {}
    for (const variant of variants) variantEfforts[variant.id] = variantEffort(variant)
    const declaredReasoning = Object.values(variantEfforts).length
      ? Math.max(...Object.values(variantEfforts))
      : undefined

    const speed = matchWords(text, SPEED_WORDS.map((word) => [word, 1] as [string, number]))
    const reasoningWords = matchWords(text, REASONING_WORDS)
    const codingWords = matchWords(text, CODING_WORDS)
    const previewWords = matchWords(text, PREVIEW_WORDS.map((word) => [word, 1] as [string, number]))
    const experimental = previewWords.words.length > 0
    const tags = [
      ...speed.words.map((word) => `fast:${word}`),
      ...reasoningWords.words.map((word) => `reason:${word}`),
      ...codingWords.words.map((word) => `code:${word}`),
      ...previewWords.words.map((word) => `preview:${word}`),
    ]

    // Reasoning combines what the model declares with what its family advertises.
    // An unknown family must not score as zero, or unbranded models lose every
    // comparison to a model that merely says "max" somewhere.
    const reasoning = clamp01(Math.max(declaredReasoning ?? 0, reasoningWords.value, 0.4))
    // Latency: fast families help, deep reasoning and high price hurt.
    const latency = clamp01(speed.value * 0.7 + cheapnessScores[index]! * 0.15 - reasoning * 0.3)
    const coding = clamp01(
      codingWords.value * 0.8 + (model.capabilities?.tools ? 0.1 : 0) + contextScores[index]! * 0.1,
    )

    return {
      ref: `${model.providerID}/${model.id}`,
      providerID: model.providerID,
      id: model.id,
      name: model.name,
      tools: model.capabilities?.tools !== false,
      vision: (model.capabilities?.input ?? []).includes("image"),
      price,
      free,
      cheapness: cheapnessScores[index]!,
      context: contextScores[index]!,
      outputLimit: outputScores[index]!,
      recency: recencyScores[index]!,
      reasoning,
      speed: latency,
      coding,
      experimental,
      variantEffort: variantEfforts,
      tags,
      released: model.time?.released,
      contextLimit: model.limit?.context,
      outputLimitTokens: model.limit?.output,
    }
  })

  if (!knownPrice) {
    notes.push(
      priced.length
        ? "Every available model is free, so cost no longer separates the roles."
        : "This catalog carries no price data; ranking relies on family, limits and release date.",
    )
  }
  return { candidates, notes }
}