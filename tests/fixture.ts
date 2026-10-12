/**
 * Model fixtures for the test suite.
 *
 * The shapes mirror what `src/selftest.ts` already builds, because that is the
 * catalog the resolver's heuristics were tuned against: if the fixtures here
 * drift, `bun test` and `/orchestra-selftest` stop agreeing about what a "cheap
 * fast tool-capable model" looks like.
 *
 * Every field has a default so a test states only the signal it is about.
 * Prices are USD per million tokens and release dates are epoch milliseconds,
 * both matching `src/types.ts`.
 */

import type { ModelInfo } from '../src/types'

export interface ModelOptions extends Partial<ModelInfo> {
  /**
   * Shorthand for `variants`. Each entry becomes a variant whose settings pin
   * `reasoningEffort`, which is what the variant selectors read.
   */
  reasoning?: Record<string, number>
}

/** Build a single `ModelInfo` with every field defaulted. */
export function model(id: string, input: number, output: number, options: ModelOptions = {}): ModelInfo {
  const { reasoning, ...rest } = options
  return {
    id,
    modelID: id,
    providerID: rest.providerID ?? 'anthropic',
    name: rest.name ?? id,
    capabilities: rest.capabilities ?? { tools: true, input: ['text'], output: ['text'] },
    cost: rest.cost ?? [{ input, output, cache: { read: input * 0.1, write: input * 1.25 } }],
    time: rest.time ?? { released: 1740000000000 },
    limit: rest.limit ?? { context: 200000, output: 8192 },
    variants:
      rest.variants ??
      Object.entries(reasoning ?? {}).map(([effort]) => ({
        id: effort,
        settings: { reasoningEffort: effort }
      })),
    ...rest
  } as ModelInfo
}

/** Build a catalog from a list of models, or from model argument tuples. */
export function catalog(...models: ModelInfo[]): ModelInfo[] {
  return [...models]
}

/**
 * The mixed multi-provider catalog the resolver fixtures are written against:
 * a cheap small model, a mid model with reasoning variants, an expensive deep
 * one, an OpenAI model with a large window, and a free local model.
 */
export function mixedCatalog(): ModelInfo[] {
  return catalog(
    model('claude-haiku-4-5', 1, 5, {
      variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
      limit: { context: 200000, output: 64000 },
      time: { released: 1748000000000 }
    }),
    model('claude-sonnet-4-5', 3, 15, {
      variants: [
        { id: 'low', settings: { reasoningEffort: 'low' } },
        { id: 'high', settings: { reasoningEffort: 'high' } }
      ],
      limit: { context: 200000, output: 64000 },
      time: { released: 1749000000000 }
    }),
    model('claude-opus-4-1', 15, 75, {
      variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
      limit: { context: 200000, output: 32000 },
      time: { released: 1746000000000 }
    }),
    model('gpt-5.2', 1.25, 10, {
      providerID: 'openai',
      variants: [
        { id: 'low', settings: { reasoningEffort: 'low' } },
        { id: 'high', settings: { reasoningEffort: 'high' } }
      ],
      limit: { context: 400000, output: 128000 },
      time: { released: 1750000000000 }
    }),
    model('qwen3-coder:30b', 0, 0, {
      providerID: 'ollama',
      limit: { context: 32768, output: 8192 },
      time: { released: 1730000000000 }
    })
  )
}

/** A tool-capable model, cheap and new. The usual "fine, nothing special". */
export function plainModel(id: string, overrides: ModelOptions = {}): ModelInfo {
  return model(id, 1, 5, overrides)
}

/** A model the provider lists but that cannot drive tools. */
export function visionOnlyModel(id = 'vision-only'): ModelInfo {
  return model(id, 1, 1, { capabilities: { tools: false, input: ['image'], output: ['text'] } })
}

/** A catalog with no entries at all, for the "nothing is available" path. */
export function emptyCatalog(): ModelInfo[] {
  return []
}
