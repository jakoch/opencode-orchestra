/**
 * Self-test for the role resolver.
 *
 * Detection is the one part of this plugin that cannot be verified by reading the
 * code: it depends entirely on whatever catalog the host exposes. This runs the
 * resolver over fixed catalogs and asserts the invariants that matter, so a
 * change to the weights or the heuristics cannot silently mis-role a model.
 *
 * Run it with `/orchestra-selftest` (enable `selftest` in the plugin options).
 */

import { ContextMonitor, occupancyTokens } from './context'
import { EVIDENCE_FILE_CAP, EvidenceStore, effectiveToolId } from './evidence'
import { FanoutGate } from './fanout'
import { describeCircuit, RepetitionGuard } from './loop-guard'
import { resolveRoles } from './roles'
import type { ModelInfo, RoleName } from './types'

interface Fixture {
  name: string
  catalog: ModelInfo[]
  pins?: Parameters<typeof resolveRoles>[0]['pins']
  overrides?: Parameters<typeof resolveRoles>[0]['overrides']
  exclude?: Parameters<typeof resolveRoles>[0]['exclude']
  expect: {
    // `role` must stay lower-case: a mapped type key is a binding, not a type
    // parameter, and PascalCase here does not compile. Biome's naming rule
    // cannot tell the two apart, so the suppression is scoped to this line.
    // biome-ignore lint/style/useNamingConvention: mapped-type binding, not a type parameter
    [role in RoleName]?: { model?: string; variant?: string; source?: string }
  }
  /** Property assertions: survive weight tuning better than a hard-coded model. */
  properties?: {
    /** This role must hold the candidate with the highest `reasoning` signal. */
    deepestRole?: RoleName
    /** This role must hold the cheapest candidate. */
    cheapestRole?: RoleName
    /** This role must hold a candidate from a low-latency family, when one exists. */
    fastFamilyRole?: RoleName
    /** The model whose family advertises latency must not be the cheapest by accident. */
    fastestRole?: RoleName
    /** No two active roles may share a model. */
    distinctModels?: boolean
  }
  notes?: RegExp[]
}

function model(
  id: string,
  input: number,
  output: number,
  options: Partial<ModelInfo> & { reasoning?: Record<string, number> } = {}
): ModelInfo {
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
      Object.entries(reasoning ?? {}).map(([id_, effort]) => ({
        id: id_,
        settings: { reasoningEffort: id_ }
      })),
    ...rest
  } as ModelInfo
}

/** Catalog shaped like a real multi-provider setup. */
const MIXED: ModelInfo[] = [
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
]

const FIXTURES: Fixture[] = [
  {
    name: 'roles split by price, speed and depth',
    catalog: MIXED,
    expect: {
      scout: { source: 'detected' },
      advisor: { source: 'detected' },
      builder: { source: 'detected' }
    },
    properties: { deepestRole: 'advisor', fastFamilyRole: 'scout', distinctModels: true }
  },
  {
    name: 'free local model does not become the advisor',
    catalog: MIXED,
    pins: { advisor: { model: 'openai/gpt-5.2', variant: 'high' } },
    expect: {
      advisor: { model: 'openai/gpt-5.2', variant: 'high', source: 'pin' }
    }
  },
  {
    name: 'plugin options beat the pin file',
    catalog: MIXED,
    pins: { advisor: { model: 'openai/gpt-5.2' } },
    overrides: { advisor: 'anthropic/claude-haiku-4-5' },
    expect: { advisor: { model: 'anthropic/claude-haiku-4-5', source: 'override' } }
  },
  {
    name: 'override for an unavailable model is reported, not silently dropped',
    catalog: MIXED,
    overrides: { advisor: 'anthropic/claude-opus-4-5' },
    expect: { advisor: { source: 'detected' } },
    notes: [/not available or has been quarantined/]
  },
  {
    name: 'stale pin falls back to detection with a note',
    catalog: MIXED,
    pins: { advisor: { model: 'anthropic/does-not-exist' } },
    expect: { advisor: { source: 'detected' } },
    notes: [/not available or has been quarantined/]
  },
  {
    name: 'single model serves every role',
    catalog: [MIXED[2]!],
    expect: {
      advisor: { model: 'anthropic/claude-opus-4-1', source: 'detected' },
      builder: { model: 'anthropic/claude-opus-4-1' },
      scout: { model: 'anthropic/claude-opus-4-1' }
    },
    notes: [/roles share a model/]
  },
  {
    name: 'catalog without tool support yields no assignment',
    catalog: [model('vision-only', 1, 1, { capabilities: { tools: false, input: ['image'], output: ['text'] } })],
    expect: {
      advisor: { model: undefined, source: 'fallback' },
      builder: { model: undefined, source: 'fallback' },
      scout: { model: undefined, source: 'fallback' }
    },
    notes: [/tool-capable model/]
  },
  {
    name: 'empty catalog does not throw',
    catalog: [],
    expect: { builder: { model: undefined, source: 'fallback' } }
  },
  {
    name: 'a quarantined model is not picked, even when it would win',
    catalog: MIXED,
    exclude: ['anthropic/claude-opus-4-1'],
    expect: { advisor: { source: 'detected' } },
    properties: { distinctModels: true },
    notes: [/Excluded 1 model/]
  },
  {
    name: 'quarantine cannot be side-stepped by a stale pin',
    catalog: MIXED,
    exclude: ['anthropic/claude-opus-4-1'],
    pins: { advisor: { model: 'anthropic/claude-opus-4-1' } },
    expect: { advisor: { model: 'openai/gpt-5.2', source: 'detected' } },
    notes: [/quarantined/]
  },
  {
    // The counterpart of the fixture above, and the only case that beats it: with
    // every offered model blocked, falling back to detection has nowhere to go,
    // so the pin is the only instruction that can produce a model. Refusing it
    // leaves the role on the session model — which is also the state where the
    // report advises the user to pin a model that answers.
    name: 'a pin is honoured when a block has emptied the catalog',
    catalog: MIXED,
    overrides: { advisor: 'anthropic/claude-opus-4-1' },
    exclude: [
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-opus-4-1',
      'openai/gpt-5.2',
      'ollama/qwen3-coder:30b'
    ],
    expect: { advisor: { model: 'anthropic/claude-opus-4-1', source: 'override' } },
    notes: [/nothing else is left/]
  },
  {
    name: 'scout picks the cheapest reasoning variant, advisor the deepest',
    catalog: MIXED,
    pins: { scout: 'anthropic/claude-sonnet-4-5', advisor: 'anthropic/claude-sonnet-4-5' },
    overrides: { scout: 'anthropic/claude-sonnet-4-5#low', advisor: 'anthropic/claude-sonnet-4-5#high' },
    expect: {
      scout: { variant: 'low', source: 'override' },
      advisor: { variant: 'high', source: 'override' }
    }
  }
]

export interface SelfTestResult {
  passed: number
  failed: number
  lines: string[]
}

/** Fixture-driven checks for the runtime signals, kept beside the resolver's. */
interface SignalFixture {
  name: string
  /** Sync for pure checks, async for the fan-out gate, which arbitrates slots. */
  run(): string[] | Promise<string[]>
}

const SIGNAL_FIXTURES: SignalFixture[] = [
  {
    name: 'evidence: writes open a debt and a verification run settles it',
    run() {
      const store = new EvidenceStore()
      const problems: string[] = []
      store.record('s1', 'edit', { filePath: '/repo/a.ts' }, 'completed')
      store.record('s1', 'edit', { filePath: '/repo/b.ts' }, 'completed')
      if (store.snapshot('s1').unverified.length !== 2) problems.push('expected 2 unverified files after two writes')
      const after = store.record('s1', 'shell', { command: 'npm test' }, 'completed')
      if (!after.verified) problems.push('expected `npm test` to count as verification')
      if (store.snapshot('s1').unverified.length !== 0) problems.push('verification should clear the debt')
      return problems
    }
  },
  {
    name: 'evidence: a failed verification run does not clear the debt',
    run() {
      const store = new EvidenceStore()
      store.record('s1', 'edit', { filePath: '/repo/a.ts' }, 'completed')
      store.record('s1', 'shell', { command: 'pytest -x' }, 'error')
      return store.snapshot('s1').unverified.length === 1 ? [] : ['a failing test run must leave files unverified']
    }
  },
  {
    name: 'evidence: unrelated shell commands are not verification',
    run() {
      const store = new EvidenceStore()
      store.record('s1', 'edit', { filePath: '/repo/a.ts' }, 'completed')
      const result = store.record('s1', 'shell', { command: 'ls -la' }, 'completed')
      return result.verified || store.snapshot('s1').unverified.length === 0
        ? ['`ls -la` must not be treated as verification']
        : []
    }
  },
  {
    name: 'evidence: namespaced and array tool inputs are understood',
    run() {
      const store = new EvidenceStore()
      store.record(
        's1',
        effectiveToolId('custom_patch'),
        { files: [{ filePath: '/repo/x.ts' }, '/repo/y.ts'] },
        'completed'
      )
      const files = store.snapshot('s1').unverified
      if (files.length !== 2) return [`expected 2 paths from a namespaced multi-file write, got ${files.length}`]
      return effectiveToolId('plain_edit') === 'edit' ? [] : ['effectiveToolId should strip the namespace']
    }
  },
  {
    name: 'loop guard: alternating tools do not trip the circuit',
    run() {
      const guard = new RepetitionGuard()
      guard.recordTool({ sessionID: 's1', tool: 'shell', result: 'a' })
      guard.recordTool({ sessionID: 's1', tool: 'read', result: 'a' })
      const verdict = guard.recordTool({ sessionID: 's1', tool: 'shell', result: 'a' })
      return verdict.open ? ['alternating tools must not trip the circuit'] : []
    }
  },
  {
    name: 'loop guard: the same tool with different arguments is not a loop',
    run() {
      const guard = new RepetitionGuard()
      // The original bug: only the tool name was compared, so `read a` -> `read
      // b` -> `read c` read as three identical calls and tripped the circuit.
      guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'a' }, result: 'a' })
      guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'b' }, result: 'b' })
      const verdict = guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'c' }, result: 'c' })
      return verdict.open ? ['different arguments are different calls and must not trip the circuit'] : []
    }
  },
  {
    name: 'loop guard: an unconfirmed call cannot open the circuit',
    run() {
      const guard = new RepetitionGuard()
      // No result at all, which is what an older host sends. Three of these
      // must NOT trip: nothing confirmed that any of them repeated.
      guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'a' } })
      guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'a' } })
      const verdict = guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'a' } })
      return verdict.open ? ['a missing result must not count as confirmation'] : []
    }
  },
  {
    name: 'loop guard: a fresh result breaks the run',
    run() {
      const guard = new RepetitionGuard()
      guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'a' }, result: 'v1' })
      guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'a' }, result: 'v2' })
      const verdict = guard.recordTool({ sessionID: 's1', tool: 'read', input: { p: 'a' }, result: 'v3' })
      return verdict.open ? ['a call that returned something new is progress, not repetition'] : []
    }
  },
  {
    name: 'loop guard: three identical confirmed calls in a row open it',
    run() {
      const guard = new RepetitionGuard()
      const call = { sessionID: 's1', tool: 'shell', input: { command: 'bun test' }, result: 'same output' }
      guard.recordTool(call)
      guard.recordTool(call)
      const verdict = guard.recordTool(call)
      if (!verdict.open) return ['expected the tool circuit to open after three identical calls']
      if (verdict.kind !== 'tool') return ['expected the circuit to be attributed to tool repetition']
      if (guard.openCount() !== 1) return ['openCount should be 1']
      guard.acknowledge('s1')
      return guard.peek('s1').open ? ['acknowledge should clear an open circuit'] : []
    }
  },
  {
    name: 'loop guard: three identical tool-free turns open the output circuit',
    run() {
      const guard = new RepetitionGuard()
      const event = { sessionID: 's1', text: 'I will continue.', hadToolCall: false }
      guard.recordOutput(event)
      guard.recordOutput(event)
      const verdict = guard.recordOutput(event)
      if (!verdict.open) return ['expected the output circuit to open']
      if (verdict.kind !== 'output') return ['expected attribution to output repetition']
      return describeCircuit(verdict).includes('identical tool-free turns') ? [] : ['description should name the cause']
    }
  },
  {
    name: 'loop guard: a tool-using turn clears the output signal',
    run() {
      const guard = new RepetitionGuard()
      const event = { sessionID: 's1', text: 'same text', hadToolCall: false }
      guard.recordOutput(event)
      guard.recordOutput(event)
      guard.recordOutput({ sessionID: 's1', text: 'same text', hadToolCall: true })
      guard.recordOutput(event)
      return guard.peek('s1').open ? ['acting again must reset the output signal'] : []
    }
  },
  {
    name: 'loop guard: the tool circuit clears itself after its short timeout',
    run() {
      const guard = new RepetitionGuard()
      const t0 = 1_000_000
      const call = { sessionID: 's1', tool: 'shell', input: { command: 'bun test' }, result: 'same output' }
      guard.recordTool(call, t0)
      guard.recordTool(call, t0 + 1)
      const verdict = guard.recordTool(call, t0 + 2)
      if (!verdict.open) return ['expected the circuit to open']
      if (guard.peek('s1', t0 + 29_000).open !== true) return ['tool circuit should still be open at 29s']
      return guard.peek('s1', t0 + 31_000).open ? ['tool circuit should auto-clear after 30s'] : []
    }
  },
  {
    name: 'loop guard: the refusal is derived from the confirmed count, not from open',
    run() {
      // The circuit opens at 3, but the refusal must survive the 30s auto-clear,
      // because `RESET_TIMEOUT_MS.tool` expires `open` on exactly the sessions
      // that still needed the refusal.
      const guard = new RepetitionGuard({ refusalTools: ['read'] })
      const call = { sessionID: 's1', tool: 'read', input: { p: 'a' }, result: 'same' }
      for (let index = 0; index < 5; index++) guard.recordTool(call)
      const pending = { sessionID: 's1', tool: 'read', input: { p: 'a' } }
      // A host that reports no status on `execute.before` must still be judged.
      if (!guard.decide(pending)) return ['the sixth identical read should be refused']
      // Different arguments are a different call and must go through.
      if (guard.decide({ sessionID: 's1', tool: 'read', input: { p: 'b' } })) {
        return ['a different file must never be refused']
      }
      // Out of scope by construction: refusing `bash` would block the builder's
      // own test loop, which `prompts.ts:69` tells it to re-run.
      if (guard.decide({ sessionID: 's1', tool: 'bash', input: { command: 'bun test' } })) {
        return ['refusal must stay scoped to read, grep and glob']
      }
      return []
    }
  },
  {
    name: "context: the model's real window is used, not a fixed default",
    run() {
      const monitor = new ContextMonitor()
      monitor.seed([
        { ref: 'p/small', context: 200_000 },
        { ref: 'p/large', context: 1_000_000 }
      ])
      monitor.rememberModel('s1', 'p', 'small')
      monitor.rememberModel('s2', 'p', 'large')
      const small = monitor.observe('s1', { input: 170_000 })
      const large = monitor.observe('s2', { input: 170_000 })
      if (!small.warning) return ['170k of 200k should warn']
      if (large.warning) return ['170k of 1M must not warn']
      if (!small.known || !large.known) return ['both limits should be known from the catalog']
      return []
    }
  },
  {
    name: 'context: an unknown model falls back without pretending to know',
    run() {
      const monitor = new ContextMonitor()
      monitor.rememberModel('s1', 'p', 'never-seen')
      const reading = monitor.observe('s1', { input: 190_000 })
      if (reading.known) return ['an unseeded model must report its limit as unknown']
      if (!reading.warning) return ['190k against a 200k fallback should warn']
      return reading.note?.includes('unknown') ? [] : ['the note should admit the limit is unknown']
    }
  },
  {
    name: 'context: an explicit override wins over the catalog',
    run() {
      const monitor = new ContextMonitor({ overrideMaxTokens: 400_000 })
      monitor.seed([{ ref: 'p/large', context: 1_000_000 }])
      monitor.rememberModel('s1', 'p', 'large')
      const reading = monitor.observe('s1', { input: 350_000 })
      return reading.limit === 400_000 && reading.warning ? [] : ['override should apply and warn']
    }
  },
  {
    name: 'context: cached prompt tokens count as occupied window',
    run() {
      // A turn billed mostly from cache still holds that prompt in the window.
      const usage = { input: 8_000, output: 300, reasoning: 2_000, cache: { read: 180_000, write: 0 } }
      const occupancy = occupancyTokens(usage)
      if (occupancy !== 190_300) return [`expected 190300 occupied tokens, got ${occupancy}`]
      const monitor = new ContextMonitor()
      monitor.seed([{ ref: 'p/m', context: 200_000 }])
      monitor.rememberModel('s1', 'p', 'm')
      const reading = monitor.observe('s1', usage)
      return reading.warning ? [] : ['190k of a 200k window must warn even though only 8k was billed']
    }
  },
  {
    name: 'context: a later cache-hit turn does not hide an earlier large window',
    run() {
      // Regression: reading only the newest turn reported 15 tokens for a
      // session whose prompt was over 30k, so the signal never fired.
      const monitor = new ContextMonitor()
      monitor.seed([{ ref: 'p/small', context: 200_000 }])
      monitor.rememberModel('s1', 'p', 'small')
      monitor.observe('s1', { input: 8_381, reasoning: 2_278, cache: { read: 22_912, write: 0 } })
      monitor.observe('s1', { input: 15, reasoning: 31, cache: { read: 4_992, write: 0 } })
      const reading = monitor.read('s1')
      if (reading.occupancy !== 33_571) return [`expected the 33571 high-water mark, got ${reading.occupancy}`]
      // 17% of the window: correctly not a warning, and the assertion above
      // proves the estimate is not the 46 tokens the newest turn reported.
      if (reading.warning) return ['17% of the window should not be a warning']
      if (!reading.ratio || reading.ratio > 0.2) return [`expected a ratio near 0.17, got ${reading.ratio}`]
      return []
    }
  },
  {
    name: 'context: forgetting a session clears its high-water mark',
    run() {
      const monitor = new ContextMonitor()
      monitor.seed([{ ref: 'p/m', context: 200_000 }])
      monitor.rememberModel('s1', 'p', 'm')
      monitor.observe('s1', { input: 150_000 })
      monitor.forget('s1')
      return monitor.read('s1').occupancy === undefined ? [] : ['forget must drop the estimate too']
    }
  },
  {
    name: 'evidence: the file cap evicts the oldest instead of clearing',
    run() {
      // Regression: hitting the cap used to clear the whole set, reporting zero
      // unverified files exactly when a session had the most of them.
      const store = new EvidenceStore()
      const total = EVIDENCE_FILE_CAP + 25
      for (let index = 0; index < total; index++) {
        store.record('s1', 'write', { path: `/repo/f${index}.ts` }, 'completed')
      }
      const held = store.count('s1')
      if (held !== EVIDENCE_FILE_CAP) return [`expected the record to stay capped at ${EVIDENCE_FILE_CAP}, got ${held}`]
      if (store.latest('s1') !== `/repo/f${total - 1}.ts`) return ['the most recent write must be retained']
      if (store.snapshot('s1').unverified.includes('/repo/f0.ts')) return ['the oldest write should have been evicted']
      return []
    }
  },
  {
    name: 'fan-out: launches up to the limit are admitted immediately',
    run() {
      const gate = new FanoutGate({ limit: 2 })
      // Exactly the limit: both are admitted. A third is the queueing case,
      // covered by the next fixture.
      return Promise.all([gate.acquire('s1'), gate.acquire('s1')]).then(results => {
        if (results.some(result => !result.ok)) return ['the first launches should not be refused']
        if (gate.inFlight('s1') !== 2) return [`expected 2 in flight, got ${gate.inFlight('s1')}`]
        return []
      })
    }
  },
  {
    name: 'fan-out: a launch past the limit queues and runs when a slot frees',
    run() {
      // The regression this exists for: a model asking for four parallel scouts
      // used to send four simultaneous provider requests and hit the rate limit.
      const gate = new FanoutGate({ limit: 2, acquireTimeoutMs: 5_000 })
      return (async () => {
        const first = await gate.acquire('s1', 'scout')
        const second = await gate.acquire('s1', 'scout')
        if (!first.slotId || !second.slotId) return ['expected slot ids for correlation']
        const queued = gate.acquire('s1', 'scout')
        if (gate.queued('s1') !== 1) return ['the third launch should be waiting, not admitted']
        gate.release('s1', first.slotId)
        const third = await queued
        if (!third.ok) return ['the queued launch should run once a slot frees']
        if (third.inFlight !== 2) return [`expected 2 in flight after admission, got ${third.inFlight}`]
        return []
      })()
    }
  },
  {
    name: 'fan-out: a launch that cannot get a slot in time is refused, not hung',
    run() {
      const gate = new FanoutGate({ limit: 1, acquireTimeoutMs: 20 })
      return (async () => {
        await gate.acquire('s1')
        const refused = await gate.acquire('s1', 'scout')
        if (refused.ok) return ['expected the second launch to be refused']
        if (!refused.refused?.includes('scout')) return ['the refusal should name what was launched']
        if (!/narrow the request|Work on the results/.test(refused.refused)) {
          return ['the refusal should tell the model what to do instead']
        }
        return []
      })()
    }
  },
  {
    name: 'fan-out: gates are per session, not global',
    run() {
      const gate = new FanoutGate({ limit: 1 })
      return (async () => {
        await gate.acquire('s1')
        const other = await gate.acquire('s2')
        return other.ok ? [] : ['a different session must not be blocked']
      })()
    }
  },
  {
    name: 'fan-out: a slot whose call never reports back is reaped',
    run() {
      let clock = 1_000_000
      const gate = new FanoutGate({ limit: 1, acquireTimeoutMs: 5_000, leaseMs: 60_000, now: () => clock })
      return (async () => {
        await gate.acquire('s1')
        clock += 120_000
        // No release: the child crashed and never reported completion.
        const next = await gate.acquire('s1')
        return next.ok ? [] : ['a stale slot should not wedge the session shut']
      })()
    }
  },
  {
    name: "fan-out: an unrelated release cannot free someone else's slot",
    run() {
      const gate = new FanoutGate({ limit: 2 })
      return (async () => {
        const held = await gate.acquire('s1')
        gate.release('s1', 'slot-that-does-not-exist')
        if (gate.inFlight('s1') !== 1) return ['an unknown slot id must not decrement the count']
        gate.release('s1', held.slotId)
        gate.release('s1', held.slotId)
        if (gate.inFlight('s1') !== 0) return ['a double release must not go negative']
        return []
      })()
    }
  },
  {
    name: 'fan-out: unloading refuses queued launches instead of stranding them',
    run() {
      const gate = new FanoutGate({ limit: 1, acquireTimeoutMs: 60_000 })
      return (async () => {
        await gate.acquire('s1')
        const queued = gate.acquire('s1')
        gate.reset()
        const outcome = await queued
        return outcome.ok ? ['a queued launch must resolve when the plugin unloads'] : []
      })()
    }
  }
]

export async function runSelfTest(): Promise<SelfTestResult> {
  const lines: string[] = []
  let passed = 0
  let failed = 0

  for (const fixture of FIXTURES) {
    const problems: string[] = []
    let resolved: ReturnType<typeof resolveRoles>
    try {
      resolved = resolveRoles({
        catalog: fixture.catalog,
        pins: fixture.pins,
        overrides: fixture.overrides,
        exclude: fixture.exclude
      })
    } catch (error) {
      lines.push(`FAIL ${fixture.name}: threw ${(error as Error).message}`)
      failed++
      continue
    }

    // `Object.entries` cannot see that the key set and the value type agree, so
    // the pair is re-typed rather than dereferenced blindly: a fixture that
    // omitted a role would otherwise report a confusing crash instead of simply
    // asserting nothing for that role.
    for (const [role, raw] of Object.entries(fixture.expect)) {
      const expectation = raw as { model?: string; variant?: string; source?: string } | undefined
      if (!expectation) continue
      const assignment = resolved.assignments[role as RoleName]
      const actual = assignment?.model ? `${assignment.model.providerID}/${assignment.model.id}` : undefined
      const actualVariant = assignment?.model?.variant
      if (expectation.model !== undefined && actual !== expectation.model) {
        problems.push(`${role}: expected model ${expectation.model ?? 'none'}, got ${actual ?? 'none'}`)
      }
      if (expectation.variant !== undefined && actualVariant !== expectation.variant) {
        problems.push(`${role}: expected variant ${expectation.variant}, got ${actualVariant ?? 'none'}`)
      }
      if (expectation.source && assignment?.source !== expectation.source) {
        problems.push(`${role}: expected source ${expectation.source}, got ${assignment?.source}`)
      }
    }

    for (const pattern of fixture.notes ?? []) {
      if (!resolved.notes.some(note => pattern.test(note))) {
        problems.push(`expected a note matching ${pattern}`)
      }
    }

    const pick = (role: RoleName) =>
      resolved.candidates.find(c => {
        const model = resolved.assignments[role]?.model
        return Boolean(model) && c.providerID === model!.providerID && c.id === model!.id
      })
    const properties = fixture.properties
    if (properties?.deepestRole) {
      const deepest = [...resolved.candidates].sort((a, b) => b.reasoning - a.reasoning)[0]
      const held = pick(properties.deepestRole)
      if (!held || held.ref !== deepest?.ref) {
        problems.push(
          `expected ${properties.deepestRole} to hold the deepest-reasoning model ${deepest?.ref ?? 'none'}, got ${held?.ref ?? 'none'}`
        )
      }
    }
    if (properties?.cheapestRole) {
      const cheapest = [...resolved.candidates].sort((a, b) => b.cheapness - a.cheapness)[0]
      const held = pick(properties.cheapestRole)
      if (!held || held.ref !== cheapest?.ref) {
        problems.push(
          `expected ${properties.cheapestRole} to hold the cheapest model ${cheapest?.ref ?? 'none'}, got ${held?.ref ?? 'none'}`
        )
      }
    }
    if (properties?.fastFamilyRole) {
      const fast = [...resolved.candidates]
        .filter(candidate => candidate.tags.some(tag => tag.startsWith('fast:')))
        .sort((a, b) => b.speed - a.speed)[0]
      if (fast) {
        const held = pick(properties.fastFamilyRole)
        if (!held || held.ref !== fast.ref) {
          problems.push(
            `expected ${properties.fastFamilyRole} to hold the low-latency model ${fast.ref}, got ${held?.ref ?? 'none'}`
          )
        }
      }
    }
    if (properties?.fastestRole) {
      const fastest = [...resolved.candidates].sort((a, b) => b.speed - a.speed)[0]
      const held = pick(properties.fastestRole)
      if (!held || held.ref !== fastest?.ref) {
        problems.push(
          `expected ${properties.fastestRole} to hold the fastest model ${fastest?.ref ?? 'none'}, got ${held?.ref ?? 'none'}`
        )
      }
    }
    if (properties?.distinctModels) {
      const refs = (Object.values(resolved.assignments) as { model?: unknown }[])
        .map(assignment => assignment.model)
        .filter(Boolean)
        .map(model => JSON.stringify(model))
      if (new Set(refs).size !== refs.length) problems.push('expected three distinct models')
    }

    if (problems.length) {
      failed++
      lines.push(`FAIL ${fixture.name}`)
      for (const problem of problems) lines.push(`     - ${problem}`)
    } else {
      passed++
      lines.push(`ok   ${fixture.name}`)
    }
  }

  for (const fixture of SIGNAL_FIXTURES) {
    let problems: string[]
    try {
      // Must be awaited: the fan-out fixtures are async, and an unawaited
      // Promise is a truthy value with no `.length`, so every one of them would
      // silently count as passing.
      problems = await fixture.run()
    } catch (error) {
      problems = [`threw ${(error as Error).message}`]
    }
    if (problems.length) {
      failed++
      lines.push(`FAIL ${fixture.name}`)
      for (const problem of problems) lines.push(`     - ${problem}`)
    } else {
      passed++
      lines.push(`ok   ${fixture.name}`)
    }
  }

  lines.push('', `${passed} passed, ${failed} failed`)
  return { passed, failed, lines }
}
