/**
 * Compile-time assertions over the host contract.
 *
 * Each block maps to a `docs/host-behavior.md` row: if the SDK moves, this
 * file — running inside `bun run typecheck` — breaks loudly instead of letting
 * the mirror in `src/plugin-types.ts` drift silently. Nothing here executes:
 * the hook calls below only exist so their callbacks are *checked*. This
 * module must never be imported at runtime; `tests/host-facts-doc.test.ts`
 * asserts that.
 *
 * `import type` only, so there is no runtime dependency beyond what the plugin
 * already ships: `@opencode/plugin` is a devDependency, and `@opencode/schema`
 * rides its pinned transitive copy (frozen lockfile).
 */
import type { Plugin } from '@opencode/plugin'
import type { Agent } from '@opencode/schema'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

/** Editors, reached through the transform callbacks (concrete — no generics). */
type AgentEditor = Parameters<Parameters<Plugin.Context['agent']['transform']>[0]>[0]
type ToolEditor = Parameters<Parameters<Plugin.Context['tool']['transform']>[0]>[0]

declare const sessionHook: Plugin.Context['session']['hook']
declare const toolHook: Plugin.Context['tool']['hook']

// H9: the agent editor has no `add`; `update` upserts.
type _H9 = Expect<'add' extends keyof AgentEditor ? false : true>
// H12: `default()` returns nothing.
type _H12 = Expect<Equal<ReturnType<AgentEditor['default']>, void>>
// The tool editor really does have `add` (H1 is about host *behavior* on
// registration, not about a missing API — if the API goes, this says so).
type _ToolAdd = Expect<'add' extends keyof ToolEditor ? true : false>
// Session registry shape: `remove` is handed to plugins, `list` is not.
type _Remove = Expect<'remove' extends keyof Plugin.Context['session'] ? true : false>
type _NoList = Expect<'list' extends keyof Plugin.Context['session'] ? false : true>

// H7: the registry model is `{ id, providerID, variant? }` — never the config
// `{ providerID, model }` shape that once broke `GET /api/agent`.
type RegistryModel = NonNullable<Agent.Info['model']>
type _H7id = Expect<'id' extends keyof RegistryModel ? true : false>
type _H7provider = Expect<'providerID' extends keyof RegistryModel ? true : false>
type _H7configShape = Expect<'model' extends keyof RegistryModel ? false : true>

// H2: the context event must not grow `kind` (it lives on the model/http/ws
// request hooks only). The `@ts-expect-error` inverts the check: it is
// satisfied today and fails loudly the day the SDK adds the field.
sessionHook('context', event => {
  // @ts-expect-error H2: SessionContext must not grow `kind`.
  const kind: undefined = event.kind
  void kind
  const messages: readonly unknown[] = event.messages
  void messages
  const system: readonly unknown[] = event.system
  void system
})

// H3: the compaction event carries the session id (all that is read) plus the
// full session context around it.
sessionHook('compaction', event => {
  const session: string = event.sessionID
  void session
  const system: readonly unknown[] = event.system
  void system
})

// H11: the retry event carries the attempt number quarantine dedupes on.
sessionHook('retry', event => {
  const attempt: number = event.attempt
  void attempt
  const session: string = event.sessionID
  void session
})

// H13: the tool hooks require the call id (and agent) on both sides.
toolHook('execute.after', event => {
  const id: string = event.id
  void id
  const agent: string = event.agent
  void agent
  const session: string = event.sessionID
  void session
})
