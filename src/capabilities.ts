/**
 * Runtime capability probing.
 * The host surface in `src/plugin-types.ts` is a hand-kept mirror and has been wrong both ways.
 * Instead of trusting it, `setup` walks this table with `typeof` and degrades per missing member.
 * Hook registration is deliberately not a degrade path — a rejected hook is a host contract violation.
 * Only members the plugin actually calls are listed; probing unused members would create code that exists only to fail.
 */
import type { PluginContextLike } from './plugin-types'
import type { SessionProbeLike } from './probe'

/** Every host member the plugin calls, by the name the report uses. */
export type Capability =
  | 'model.list'
  | 'model.default'
  | 'model.transform'
  | 'agent.transform'
  | 'command.transform'
  | 'session.create'
  | 'session.switchAgent'
  | 'session.switchModel'
  | 'session.prompt'
  | 'session.wait'
  | 'session.remove'
  | 'session.move'
  | 'session.context'
  | 'session.hook.retry'
  | 'session.hook.context'
  | 'session.hook.compaction'
  | 'tool.transform'
  | 'tool.hook.execute.before'
  | 'tool.hook.execute.after'
  | 'storage.get'
  | 'storage.set'
  | 'generate.text'

/** Dotted path from the plugin context root to each member. */
export const PATHS: Record<Capability, string> = {
  'model.list': 'model.list',
  'model.default': 'model.default',
  'model.transform': 'model.transform',
  'agent.transform': 'agent.transform',
  'command.transform': 'command.transform',
  'session.create': 'session.create',
  'session.switchAgent': 'session.switchAgent',
  'session.switchModel': 'session.switchModel',
  'session.prompt': 'session.prompt',
  'session.wait': 'session.wait',
  'session.remove': 'session.remove',
  'session.move': 'session.move',
  'session.context': 'session.context',
  'session.hook.retry': 'session.hook',
  'session.hook.context': 'session.hook',
  'session.hook.compaction': 'session.hook',
  'tool.transform': 'tool.transform',
  'tool.hook.execute.before': 'tool.hook',
  'tool.hook.execute.after': 'tool.hook',
  'storage.get': 'storage.get',
  'storage.set': 'storage.set',
  'generate.text': 'generate.text'
}

/** Members the plugin never calls; the table must not grow to include them. */
export const NEVER_CALLED = [
  'app',
  'location.project',
  'tool.list',
  'command.list',
  'agent.list',
  'agent.reload',
  'model.reload',
  'session.get',
  'session.interrupt',
  'session.update',
  'storage.remove'
] as const

export interface CapabilityReport {
  has(name: Capability): boolean
  missing(): Capability[]
}

function resolvePath(root: unknown, path: string): unknown {
  let current = root
  for (const segment of path.split('.')) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** One `typeof` walk over the context; no per-site logic. */
export function detectCapabilities(ctx: PluginContextLike): CapabilityReport {
  const absent = (Object.keys(PATHS) as Capability[]).filter(
    name => typeof resolvePath(ctx, PATHS[name]) !== 'function'
  )
  const missing = new Set<Capability>(absent)
  return {
    has: (name: Capability) => !missing.has(name),
    missing: () => [...missing]
  }
}

/**
 * The single session adapter.
 * Replaces hand-rolled literals at each call site. An absent member rejects with a fixed
 * message naming the capability — never a bare `TypeError`, and never a silent no-op.
 * Rejection (not a sync throw) matters because `finally` paths attach `.catch`,
 * which a synchronous throw would bypass — turning a successful delegation into a thrown error.
 */
export function sessionAdapter(ctx: PluginContextLike, caps: CapabilityReport): SessionProbeLike {
  const unavailable = (cap: Capability, method: string): Promise<never> =>
    Promise.reject(
      new Error(
        `opencode-orchestra: cannot delegate: the host does not provide session.${method} (missing capability: ${cap})`
      )
    )
  return {
    create: input => (caps.has('session.create') ? ctx.session.create(input) : unavailable('session.create', 'create')),
    move: input => (caps.has('session.move') ? ctx.session.move(input) : unavailable('session.move', 'move')),
    switchAgent: input =>
      caps.has('session.switchAgent')
        ? ctx.session.switchAgent(input)
        : unavailable('session.switchAgent', 'switchAgent'),
    switchModel: input =>
      caps.has('session.switchModel')
        ? ctx.session.switchModel(input)
        : unavailable('session.switchModel', 'switchModel'),
    prompt: input => (caps.has('session.prompt') ? ctx.session.prompt(input) : unavailable('session.prompt', 'prompt')),
    wait: input => (caps.has('session.wait') ? ctx.session.wait(input) : unavailable('session.wait', 'wait')),
    remove: input => (caps.has('session.remove') ? ctx.session.remove(input) : unavailable('session.remove', 'remove')),
    context: input =>
      caps.has('session.context') ? ctx.session.context(input) : unavailable('session.context', 'context')
  }
}

/** Process-local storage for a host without storage. Says nothing by itself. */
export function memoryStorage(): PluginContextLike['storage'] {
  const kept = new Map<string, unknown>()
  return {
    get: key => Promise.resolve(kept.get(key)),
    set: (key, value) => {
      kept.set(key, value)
      return Promise.resolve()
    },
    remove: key => {
      kept.delete(key)
      return Promise.resolve()
    }
  }
}
