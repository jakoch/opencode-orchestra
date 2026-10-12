/**
 * Mock plugin context for `bun test`.
 *
 * OpenCode ships no test helper for the V2 plugin API, so the context is
 * hand-rolled. It is typed against `PluginContextLike` — the same structural
 * surface `plugin/index.ts` is written against — so the mock cannot drift away
 * from the plugin: if the surface grows a method, this file stops compiling.
 *
 * The mock is not trying to be a convincing host. It is trying to be
 * *inspectable*. A hook callback registered by the plugin is unreachable from a
 * test otherwise — the host owns the only reference — so every registration is
 * kept here keyed by hook name and can be fired on demand. `session.prompt` is
 * recorded for the same reason: the plugin's entire user-visible output is a
 * prompt, so a test that wants to know what `/orchestra` prints inspects the
 * recorded prompt instead of reaching into the plugin's internals.
 */

import { type Capability, PATHS } from '../src/capabilities'
import type {
  AgentEditorLike,
  AgentInfoLike,
  CommandDefinitionLike,
  CommandInvocationLike,
  CompactionHookEventLike,
  ContextHookEventLike,
  ModelEditorLike,
  PluginContextLike,
  RetryHookEventLike,
  TokenUsageLike,
  ToolHookEventLike
} from '../src/plugin-types'
import type { ModelInfo } from '../src/types'

/** The probe's prompt, mirrored from src/probe.ts so the harness can scope refusals to it. */
const PROBE_TEXT = 'Reply with the single word: ok'

/** The hook names this plugin can register. */
export type HookName = 'retry' | 'context' | 'compaction' | 'execute.before' | 'execute.after'

/** Any event a registered hook can receive. Narrow it at the call site. */
export type AnyHookEvent = ContextHookEventLike | RetryHookEventLike | CompactionHookEventLike | ToolHookEventLike

export interface HookRecord {
  name: HookName
  /** Which half of the context registered it: `session.hook` or `tool.hook`. */
  surface: 'session' | 'tool'
  callback: (event: never) => unknown
  /** Passed through verbatim, e.g. `session.hook("retry", cb, { providerID })`. */
  options?: { providerID?: string }
  disposed: boolean
  dispose(): Promise<void>
}

export interface TransformRecord {
  surface: 'agent' | 'model' | 'command' | 'tool'
  /** Number of times the plugin has called `transform` on this surface. */
  index: number
  disposed: boolean
  dispose(): Promise<void>
}

export interface PromptCall {
  sessionID: string
  text: string
  delivery?: 'steer' | 'queue'
  files?: unknown[]
  agents?: string[]
  skills?: string[]
}

export interface FiredHook {
  name: HookName
  event: unknown
}

export interface PluginHarnessOptions {
  directory?: string
  /** Plugin options, i.e. what `opencode.jsonc` passes to `setup`. */
  options?: Record<string, unknown>
  version?: string
  models?: readonly ModelInfo[]
  /** Agents the project already defines, which the plugin must not clobber. */
  agents?: readonly AgentInfoLike[]
  tools?: readonly { id: string }[]
  /** Tools the host already ships, e.g. `subagent`, which the plugin may wrap in place. */
  hostTools?: readonly { id: string; execute?: unknown; [key: string]: unknown }[]
  commands?: readonly { name: string }[]
  defaultModel?: ModelInfo | undefined
  /** What `session.context` returns: the transcript, usage included. */
  contextMessages?: readonly { tokens?: TokenUsageLike }[]
  storage?: Record<string, unknown>
  /**
   * Host members to delete off the finished context, by capability name.
   * Deletion follows the same `PATHS` table the plugin probes with, so a test
   * that silently omits the wrong member fails loudly instead of testing a
   * host the table does not describe.
   */
  omit?: Capability[]
}

let sessionCounter = 0

function nextSessionID(): string {
  sessionCounter += 1
  return `ses_${sessionCounter}`
}

/**
 * Where the real host puts a session created without a `location`.
 *
 * Verified against a running server: with the service booted from `/`,
 * `POST /api/session {"title": "..."}` returns `location.directory = "/"`.
 */
export const SERVER_DEFAULT_DIRECTORY = '/'

export class PluginHarness {
  readonly ctx: PluginContextLike

  /** Live agent registry, mutated in place by `agent.transform`. */
  readonly agents = new Map<string, AgentInfoLike>()
  /** Registered commands, keyed by name. */
  readonly commands = new Map<string, CommandDefinitionLike>()
  /** Plugin storage, i.e. what survives a reload. */
  readonly store = new Map<string, unknown>()

  /** Every hook callback ever registered, keyed by hook name. */
  readonly hooks = new Map<HookName, HookRecord[]>()
  /** Every `transform` registration, in call order, per surface. */
  readonly transforms: TransformRecord[] = []
  /** Every `session.prompt` the plugin issued. */
  readonly prompts: PromptCall[] = []
  /** Every hook firing, for ordering assertions. */
  readonly fired: FiredHook[] = []
  /** Flat log of every context call, as `"surface.method"` or `"surface.method:arg"`. */
  readonly calls: string[] = []
  /** Ids of sessions this plugin opened, in order. Distinguishes them from host-created ones. */
  readonly openedSessions: string[] = []
  /** Every `generate.text` the plugin issued, for `/orchestra probe`. */
  readonly generated: { prompt: string; model?: { providerID: string; id: string; variant?: string } }[] = []
  /** Refusals keyed by `provider/id`; a listed model throws instead of answering. */
  readonly generateFailures: Record<string, string> = {}
  /** What a successful probe replies. The text is not the point; arriving is. */
  generateText = 'ok'
  /** Sessions torn down by the session-backed probe, in order. */
  readonly removedSessions: string[] = []
  /** Model the last `switchModel`/`switchAgent` pointed a session at. */
  sessionModel: { providerID: string; id: string } | undefined
  /** Agent the last `switchAgent` installed. */
  sessionAgent: string | undefined
  /** Directory the session was last moved to. */
  sessionDirectory: string | undefined
  /**
   * Directory each session was *born* in, keyed by session id.
   *
   * A create with no `location` lands in the server's default directory on the
   * real host — `/` for a service booted from `/` — and prompting such a session
   * boots that location on the server. `create` models that as
   * `SERVER_DEFAULT_DIRECTORY`, so a test can assert the plugin never opens a
   * session there.
   */
  readonly sessionBirthDirectory = new Map<string, string>()
  /** Text of the most recent session prompt, for replaying a reply. */
  lastPrompted: string | undefined
  /** Tools the plugin registered through `tool.transform`. */
  readonly registeredTools = new Map<string, Record<string, unknown>>()
  /** Ids passed to `tool.update`, whether or not the host exposed them. */
  readonly updatedTools: string[] = []
  /** Namespace the plugin last registered tools under. */
  toolNamespace: string | undefined
  /** Assistant replies a prompted session produces, keyed by prompt text. */
  sessionReplies: Record<string, string> = {}
  /** Refusals for `switchAgent`, keyed by agent id. */
  readonly agentFailures: Record<string, string> = {}
  /** Refusals for the session-backed route, keyed by `provider/id`. */
  readonly sessionFailures: Record<string, string> = {}
  /**
   * Refusals for the session-backed *delegation* route, keyed by `provider/id`.
   *
   * Separate from `sessionFailures`, which is scoped to the probe's own prompt so
   * the report still reaches the user when every model refuses. A delegation
   * carries the question the builder asked, so it cannot be recognised by its
   * text — it is recognised by the session: only a session this harness saw
   * switched onto an agent and a model is a delegation, which is also why
   * delivering a report is never affected by what is set here.
   */
  readonly delegateFailures: Record<string, string> = {}
  /**
   * Delegations that are accepted and then never answered, keyed by `provider/id`.
   *
   * The killed-mid-flight case. `session.prompt` resolves and `session.wait`
   * never does, which is exactly what an interrupted subagent looks like from
   * the plugin: the turn was real, and its outcome is nobody's to report. The
   * delegation timeout is what finally ends it, so a test driving this also has
   * to set a short `delegateTimeoutMs`.
   */
  readonly delegateHangs: Record<string, boolean> = {}
  /** Model each routed session was pointed at, by session id. */
  private readonly routed = new Map<string, { providerID: string; id: string }>()

  private catalog: ModelInfo[]
  private readonly toolIDs: { id: string }[]
  private readonly commandNames: { name: string }[]
  private sessionDefault: ModelInfo | undefined
  private sessionMessages: readonly { tokens?: TokenUsageLike }[]
  private defaultAgentID: string | undefined

  constructor(options: PluginHarnessOptions = {}) {
    this.catalog = [...(options.models ?? [])]
    this.toolIDs = [...(options.tools ?? [])]
    this.commandNames = [...(options.commands ?? [])]
    this.sessionDefault = options.defaultModel
    this.sessionMessages = options.contextMessages ?? []
    for (const agent of options.agents ?? []) this.agents.set(agent.id, { ...agent })
    for (const [key, value] of Object.entries(options.storage ?? {})) this.store.set(key, value)
    // Host tools the plugin may rewrite. Absent from `tool.list` output unless asked for, so a
    // test opts in by passing `hostTools`.
    for (const tool of options.hostTools ?? [])
      this.registeredTools.set(tool.id, { ...tool } as Record<string, unknown>)

    this.ctx = this.buildContext({
      directory: options.directory ?? '/repo',
      options: options.options ?? {},
      version: options.version ?? '0.0.0-test'
    })
    // The harness is typed by construction, so optional members cannot simply
    // be left out of the literal — that would destroy the guard. Omission
    // happens here, off the finished object, through the shared table.
    for (const name of options.omit ?? []) deleteMember(this.ctx, PATHS[name])
  }

  // ---------------------------------------------------------------- accessors

  /** Live hook callbacks for a hook name, excluding ones already disposed. */
  registrations(name: HookName): HookRecord[] {
    return (this.hooks.get(name) ?? []).filter(record => !record.disposed)
  }

  hookNames(): HookName[] {
    return [...this.hooks.keys()]
  }

  agent(id: string): AgentInfoLike | undefined {
    return this.agents.get(id)
  }

  /** The default primary agent id, as `editor.default()` reports it. */
  defaultAgent(): string | undefined {
    return this.defaultAgentID
  }

  /** The session default model, as `model.default()` reports it. */
  modelDefault(): { providerID: string; modelID: string } | undefined {
    const model = this.sessionDefault
    return model ? { providerID: model.providerID, modelID: model.id } : undefined
  }

  /** Replace the catalog mid-test, the way a provider gaining a model would. */
  setCatalog(models: readonly ModelInfo[]): void {
    this.catalog = [...models]
  }

  /** Replace what `session.context` returns, to drive the context-pressure hook. */
  setSessionMessages(messages: readonly { tokens?: TokenUsageLike }[]): void {
    this.sessionMessages = messages
  }

  /** Every recorded prompt text, oldest first. */
  promptTexts(): string[] {
    return this.prompts.map(call => call.text)
  }

  /** The most recent prompt, or undefined when the plugin never spoke. */
  lastPrompt(): PromptCall | undefined {
    return this.prompts[this.prompts.length - 1]
  }

  /** Run a registered slash command the way the host would. */
  async runCommand(name: string, input: Partial<CommandInvocationLike> = {}): Promise<void> {
    const command = this.commands.get(name)
    if (!command)
      throw new Error(`no command registered as "${name}" (have: ${[...this.commands.keys()].join(', ') || 'none'})`)
    await command.execute({
      sessionID: input.sessionID ?? 'ses_cmd',
      prompt: input.prompt ?? { text: '' },
      delivery: input.delivery
    })
  }

  /**
   * Fire every live callback for a hook name.
   *
   * Async callbacks are awaited: the fan-out gate registers an async
   * `execute.before` and blocks on it, so a test that fired it without awaiting
   * would race the very slot accounting it is trying to check.
   */
  async fire(name: HookName, event: unknown): Promise<void> {
    for (const record of this.registrations(name)) {
      this.fired.push({ name, event })
      await (record.callback as (input: unknown) => unknown)(event)
    }
  }

  /**
   * The text a `session.hook("context")` firing pushed onto `event.system`.
   *
   * The hook decorates the event in place — that is the only channel it has to
   * reach the builder — so a test reads what landed there rather than reaching
   * into the plugin's internals, which are not observable from outside.
   */
  systemText(event: { system?: { text?: string }[] }): string[] {
    return (event.system ?? []).map(entry => entry.text ?? '').filter(Boolean)
  }

  /** A `context` event as the host sends it, with a fresh `system` array. */
  contextEvent(sessionID: string, messages: readonly unknown[] = [], kind?: ContextHookEventLike['kind']) {
    return {
      sessionID,
      agent: 'builder',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
      ...(kind ? { kind } : {}),
      system: [] as { type: string; text?: string }[],
      messages,
      options: {}
    }
  }

  fireSessionRetry(event: RetryHookEventLike): Promise<void> {
    return this.fire('retry', event)
  }

  fireSessionContext(event: ContextHookEventLike): Promise<void> {
    return this.fire('context', event)
  }

  fireToolBefore(event: ToolHookEventLike): Promise<void> {
    return this.fire('execute.before', event)
  }

  fireToolAfter(event: ToolHookEventLike): Promise<void> {
    return this.fire('execute.after', event)
  }

  /**
   * Let fire-and-forget work settle.
   *
   * Several plugin paths are deliberately unawaited — the retry hook re-detects
   * with `void apply()`, the context hook reads usage off the critical path —
   * so asserting straight after `fire` would observe a half-applied state.
   */
  async settle(): Promise<void> {
    for (let tick = 0; tick < 4; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  }

  /** Dispose everything the plugin registered, as a plugin unload would. */
  async disposeAll(): Promise<void> {
    for (const record of this.transforms) if (!record.disposed) await record.dispose()
    for (const records of this.hooks.values()) {
      for (const record of records) if (!record.disposed) await record.dispose()
    }
  }

  // ------------------------------------------------------------------ context

  /**
   * The mocked context.
   *
   * Built through a function with an explicit `PluginContextLike` return type
   * rather than an `as` cast, so the object literal is checked for missing or
   * misspelled members instead of being waved through.
   */
  private buildContext(scope: {
    directory: string
    options: Record<string, unknown>
    version: string
  }): PluginContextLike {
    const harness = this
    return {
      app: { version: scope.version },
      location: {
        directory: scope.directory,
        project: { id: 'prj_test', directory: scope.directory, canonical: scope.directory }
      },
      options: scope.options,

      model: {
        async list() {
          harness.log('model.list')
          // A copy per call: the resolver is allowed to hand catalog entries
          // around, and a test that swapped the catalog must not be able to have
          // its fixture rewritten underneath it.
          return { data: harness.catalog.map(entry => ({ ...entry })) }
        },
        async default() {
          harness.log('model.default')
          return { data: harness.sessionDefault }
        },
        transform(callback) {
          harness.log('model.transform')
          return harness.runTransform('model', () => callback(harness.modelEditor()))
        }
      },

      agent: {
        async list() {
          harness.log('agent.list')
          return { data: harness.agentList() }
        },
        transform(callback) {
          harness.log('agent.transform')
          return harness.runTransform('agent', () => callback(harness.agentEditor()))
        },
        async reload() {
          harness.log('agent.reload')
        }
      },

      command: {
        async list() {
          harness.log('command.list')
          return { data: [...harness.commandNames, ...[...harness.commands.keys()].map(name => ({ name }))] }
        },
        transform(callback) {
          harness.log('command.transform')
          return harness.runTransform('command', () => callback(harness.commandEditor()))
        }
      },

      session: {
        async prompt(input) {
          harness.log('session.prompt')
          // The session-backed probe route can be made to refuse, so a test can
          // tell "the model is unusable" apart from "the plugin cannot reach
          // any model" — the distinction this module exists to preserve.
          //
          // Scoped to probe sessions only. The plugin also prompts the user's
          // own session to deliver its report, and that must keep working even
          // when every model refuses, or a probe failure would silence the very
          // message explaining it.
          harness.lastPrompted = input.text
          const agentFailure = harness.sessionAgent ? harness.agentFailures[harness.sessionAgent] : undefined
          if (agentFailure) throw new Error(agentFailure)
          if (input.text === PROBE_TEXT && harness.sessionModel) {
            const failure = harness.sessionFailures[`${harness.sessionModel.providerID}/${harness.sessionModel.id}`]
            if (failure) throw new Error(failure)
          }
          // Delegation failures are keyed by model, so a retry onto a different
          // candidate can succeed — which is the only way to tell "moved" from
          // "gave up". Routed sessions only, so report delivery is untouched.
          const routed = harness.routed.get(input.sessionID)
          if (routed) {
            const failure = harness.delegateFailures[`${routed.providerID}/${routed.id}`]
            if (failure) throw new Error(failure)
          }
          harness.prompts.push({
            sessionID: input.sessionID,
            text: input.text,
            delivery: input.delivery,
            files: input.files,
            agents: input.agents,
            skills: input.skills
          })
          return undefined
        },
        async create(input?: { title?: string; location?: { directory: string } }) {
          const id = nextSessionID()
          harness.openedSessions.push(id)
          harness.log(`session.create:${input?.title ?? ''}`)
          const directory = input?.location?.directory ?? SERVER_DEFAULT_DIRECTORY
          harness.sessionBirthDirectory.set(id, directory)
          return { id, location: { directory } }
        },
        async move(input) {
          harness.log(`session.move:${input.directory}`)
          harness.sessionDirectory = input.directory
        },
        async switchModel(input) {
          harness.log(`session.switchModel:${input.model.providerID}/${input.model.id}`)
          harness.sessionModel = input.model
          harness.routed.set(input.sessionID, input.model)
        },
        async switchAgent(input) {
          harness.log(`session.switchAgent:${input.agent}`)
          harness.sessionAgent = input.agent
          // A real host installs the agent's model on the session too, so the
          // delegation tests see the same ordering the plugin relies on.
          const agent = harness.agents.get(input.agent)
          if (agent?.model) {
            harness.sessionModel = { providerID: agent.model.providerID, id: agent.model.id }
            harness.routed.set(input.sessionID, harness.sessionModel)
          }
        },
        async wait(input) {
          harness.log(`session.wait:${input.sessionID}`)
          // A hung delegation never finishes, which is the whole point: the
          // plugin's own timeout has to be what ends it, so the outcome really
          // is unobserved rather than reported as an error by the harness.
          if (harness.hangsOn(input.sessionID)) await new Promise<void>(() => undefined)
        },
        async remove(input) {
          harness.log(`session.remove:${input.sessionID}`)
          harness.removedSessions.push(input.sessionID)
          harness.routed.delete(input.sessionID)
        },
        async get(input) {
          return { id: input.sessionID, model: harness.sessionModel }
        },
        hook(name, callback, options?) {
          harness.log(`session.hook:${name}`)
          // `PluginContextLike` overloads `hook`, so the options bag arrives as
          // `unknown` here. Narrow it rather than casting the whole call: the
          // record's `options` field is typed, so a wrong shape is a compile
          // error at the assignment instead of a silent bad value at runtime.
          const scoped = options as { providerID?: string } | undefined
          return harness.registerHook('session', name, callback, scoped)
        },
        async context(input) {
          harness.log(`session.context:${input.sessionID}`)
          // A delegation turn's answer lives here: the harness replays the reply
          // registered for whatever text was prompted, shaped like a real
          // transcript so `extractReply` is exercised rather than bypassed.
          const last = harness.lastPrompted
          if (last !== undefined) {
            const reply = harness.sessionReplies[last]
            if (reply !== undefined) {
              // Shaped like SessionMessageInfo: `type` + a `content` array whose
              // items are discriminated by their own type. Verified against a
              // live session; the earlier role/parts guess did not match and
              // made a working agent look mute.
              return [
                { type: 'user', text: last },
                {
                  type: 'assistant',
                  agent: harness.sessionAgent ?? 'build',
                  model: { providerID: 'opencode', id: 'fixture' },
                  content: [
                    { type: 'reasoning', text: 'ignored' },
                    { type: 'text', text: reply }
                  ],
                  finish: 'stop'
                }
              ]
            }
          }
          return harness.sessionMessages
        }
      },

      tool: {
        async list() {
          harness.log('tool.list')
          return harness.toolIDs
        },
        transform(callback) {
          harness.log('tool.transform')
          return harness.runTransform('tool', () =>
            callback({
              namespace(namespace: { name: string }) {
                harness.log(`tool.namespace:${namespace.name}`)
                harness.toolNamespace = namespace.name
              },
              add(tool) {
                harness.registeredTools.set(tool.name, tool as Record<string, unknown>)
              },
              update(id: string, apply: (tool: Record<string, unknown>) => void) {
                harness.log('tool.update')
                harness.updatedTools.push(id)
                // Applies for real: the plugin wraps the host's own `subagent` this way, and a
                // stub that logged without calling through would leave that path unverified.
                const tool = harness.registeredTools.get(id)
                if (tool) apply(tool)
              },
              remove(id: string) {
                harness.registeredTools.delete(id)
              }
            })
          )
        },
        hook(name, callback) {
          harness.log(`tool.hook:${name}`)
          return harness.registerHook('tool', name, callback)
        }
      },

      storage: {
        async get(key) {
          harness.log(`storage.get:${key}`)
          return harness.store.get(key)
        },
        async set(key, value) {
          harness.log(`storage.set:${key}`)
          harness.store.set(key, value)
        },
        async remove(key) {
          harness.log(`storage.remove:${key}`)
          harness.store.delete(key)
        }
      },

      generate: {
        async text(input) {
          const ref = input.model ? `${input.model.providerID}/${input.model.id}` : '(session default)'
          harness.log(`generate.text:${ref}`)
          harness.generated.push({ prompt: input.prompt, model: input.model })
          const failure = harness.generateFailures[ref]
          if (failure) throw new Error(failure)
          return { text: harness.generateText }
        }
      }
    }
  }

  private log(entry: string): void {
    this.calls.push(entry)
  }

  /** Whether the delegation routed through this session was told to hang. */
  private hangsOn(sessionID: string): boolean {
    const model = this.routed.get(sessionID)
    if (!model) return false
    return this.delegateHangs[`${model.providerID}/${model.id}`] === true
  }

  /**
   * Call a tool the plugin registered, the way the host does.
   *
   * The host passes a `ToolContext` carrying the caller's `sessionID`, which is
   * the only handle tying a tool's effects to the turn that asked for them.
   * Tests that do not care pass nothing, exactly as the older ones do.
   */
  async callTool<T = { content: { text: string }[]; isError?: boolean }>(
    name: string,
    input: unknown,
    context?: { sessionID?: string }
  ): Promise<T> {
    const tool = this.registeredTools.get(name)
    if (!tool) throw new Error(`tool ${name} was not registered`)
    const execute = tool.execute as (input: unknown, context?: unknown) => Promise<T>
    return execute(input, context)
  }

  private registerHook(
    surface: 'session' | 'tool',
    name: HookName,
    callback: (event: never) => unknown,
    options?: { providerID?: string }
  ): Promise<{ dispose(): Promise<void> }> {
    const record: HookRecord = {
      name,
      surface,
      callback,
      options,
      disposed: false,
      dispose: async () => {
        record.disposed = true
      }
    }
    const records = this.hooks.get(name)
    if (records) records.push(record)
    else this.hooks.set(name, [record])
    return Promise.resolve(record)
  }

  /**
   * Run a transform callback and remember how to undo it.
   *
   * A real transform reverts its edits on dispose, and the plugin depends on
   * that: it disposes before re-registering so a re-detected model replaces the
   * old one rather than piling up. A mock that ignored dispose would hide the
   * difference between "re-registered" and "registered twice".
   */
  private async runTransform(
    surface: 'agent' | 'model' | 'command' | 'tool',
    apply: () => void
  ): Promise<{ dispose(): Promise<void> }> {
    const agentSnapshot = this.agents.size ? new Map([...this.agents].map(([id, agent]) => [id, { ...agent }])) : null
    const defaultAgentSnapshot = this.defaultAgentID
    const modelDefaultSnapshot = this.sessionDefault
    const commandSnapshot = new Set(this.commands.keys())

    apply()

    const record: TransformRecord = {
      surface,
      index: this.transforms.filter(item => item.surface === surface).length,
      disposed: false,
      dispose: async () => {
        record.disposed = true
        if (surface === 'agent') {
          this.agents.clear()
          if (agentSnapshot) for (const [id, agent] of agentSnapshot) this.agents.set(id, agent)
          this.defaultAgentID = defaultAgentSnapshot
        }
        if (surface === 'model') this.sessionDefault = modelDefaultSnapshot
        if (surface === 'command') {
          for (const name of this.commands.keys()) if (!commandSnapshot.has(name)) this.commands.delete(name)
        }
      }
    }
    this.transforms.push(record)
    return record
  }

  private agentList(): AgentInfoLike[] {
    return [...this.agents.values()].map(agent => ({ ...agent }))
  }

  private agentEditor(): AgentEditorLike {
    const harness = this
    return {
      list: () => harness.agentList(),
      get: id => {
        const agent = harness.agents.get(id)
        return agent ? { ...agent } : undefined
      },
      default(id) {
        // Setter only, like the host: `AgentEditor.default` returns void, so a
        // mock that reads the default back would promise what no host does.
        if (id !== undefined) harness.defaultAgentID = id
      },
      update(id, update) {
        // `update` creates on the host, and the plugin relies on that: it only
        // calls `update` for a *new* role after checking `get` returns nothing.
        const agent = harness.agents.get(id) ?? { id, name: id }
        update(agent)
        agent.id = id
        // The host decodes an `Agent.Info` on the way out, and `model` is a
        // `Model.Ref` — so an entry missing `id` fails to encode and takes the
        // whole agent list with it (`/api/agent` answers
        // `Missing key at ["data"][0]["model"]["id"]`). Enforced here so a test
        // cannot assert a shape the host would refuse.
        if (agent.model && !agent.model.id) {
          throw new Error(`agent "${id}" has a model without an id: ${JSON.stringify(agent.model)}`)
        }
        harness.agents.set(id, agent)
      },
      remove(id) {
        harness.agents.delete(id)
      }
    }
  }

  private modelEditor(): ModelEditorLike {
    return {
      list: providerID =>
        this.catalog.filter(model => !providerID || model.providerID === providerID).map(model => ({ ...model })),
      default: {
        get: () => {
          const model = this.sessionDefault
          return model ? { providerID: model.providerID, modelID: model.id } : undefined
        },
        set: (providerID, modelID) => {
          this.log(`model.default.set:${providerID}/${modelID}`)
          this.sessionDefault = this.catalog.find(model => model.providerID === providerID && model.id === modelID)
        }
      }
    }
  }

  private commandEditor(): { add(definition: CommandDefinitionLike): void } {
    const harness = this
    return {
      add(definition) {
        harness.commands.set(definition.name, definition)
      }
    }
  }
}

export function createPluginHarness(options: PluginHarnessOptions = {}): PluginHarness {
  return new PluginHarness(options)
}

/** Deletes the member at a dotted path off an object. The harness-only half of capability omission. */
function deleteMember(root: object, path: string): void {
  const segments = path.split('.')
  let target = root as Record<string, unknown>
  for (const segment of segments.slice(0, -1)) {
    const next = target[segment]
    if (next === null || (typeof next !== 'object' && typeof next !== 'function')) return
    target = next as Record<string, unknown>
  }
  delete target[segments[segments.length - 1]!]
}

/** A `CommandInvocationLike` with sensible defaults for `runCommand`. */
export function invocation(overrides: Partial<CommandInvocationLike> = {}): CommandInvocationLike {
  return {
    sessionID: 'ses_cmd',
    prompt: { text: '' },
    delivery: 'steer',
    ...overrides
  }
}
