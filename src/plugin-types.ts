/**
 * Structural mirrors of `@opencode/plugin`, declared here so the plugin loads with zero installed
 * dependencies. The host only reads the default export's `id` and `setup`, so a plain object is a
 * valid plugin; install `@opencode/plugin` to type-check the entrypoint against the real contract.
 */

import type { PermissionRule } from './agents'
import type { ModelInfo } from './types'

export interface AgentInfoLike {
  id: string
  name: string
  /**
   * The agent's own model, in the host's **registry** shape — the same
   * `{id, providerID, variant}` a session carries, because `AgentEditor.update`
   * hands the callback a resolved `Agent.Info`, not the config it came from.
   *
   * `{providerID, model, variant}` is the *config* shape, from `opencode.jsonc`.
   * Writing it here produces an agent whose model has no `id` — not a rejected
   * definition but an unserializable one, so the whole agent list fails to encode
   * and the chat dialog's model selector comes up empty. See `agentModel()`.
   */
  model?: { id: string; providerID: string; variant?: string }
  system?: string
  description?: string
  mode?: 'primary' | 'subagent' | 'all'
  hidden?: boolean
  color?: string
  steps?: number
  permissions?: PermissionRule[]
  request?: { settings?: Record<string, unknown>; headers?: Record<string, string>; body?: Record<string, unknown> }
  [key: string]: unknown
}

export interface AgentEditorLike {
  list(): readonly AgentInfoLike[]
  get(id: string): AgentInfoLike | undefined
  /**
   * Select the default primary agent. Returns nothing: the SDK declares `void`,
   * so a mock that reads the default back promises what the host never does.
   * [host-H12]
   */
  default(id: string | undefined): void
  update(id: string, update: (agent: AgentInfoLike) => void): void
  remove(id: string): void
}

export interface ModelEditorLike {
  list(providerID?: string): readonly ModelInfo[]
  readonly default: {
    get(): { providerID: string; modelID: string } | undefined
    set(providerID: string, modelID: string): void
  }
}

export interface CommandInvocationLike {
  sessionID: string
  prompt: { text: string; files?: unknown[]; agents?: string[]; skills?: string[] }
  delivery?: 'steer' | 'queue'
}

export interface PluginContextLike {
  app: { version?: string }
  location: { directory: string; project?: { id: string; directory: string; canonical: string } }
  options: Record<string, unknown>
  model: {
    list(): Promise<{ location?: unknown; data: ModelInfo[] }>
    default(): Promise<{ location?: unknown; data?: ModelInfo }>
    transform(callback: (editor: ModelEditorLike) => void): Promise<{ dispose(): Promise<void> }>
  }
  agent: {
    list(): Promise<{ location?: unknown; data: AgentInfoLike[] }>
    transform(callback: (editor: AgentEditorLike) => void): Promise<{ dispose(): Promise<void> }>
    reload(): Promise<void>
  }
  command: {
    list(): Promise<{ data?: { name: string }[] }>
    transform(callback: (editor: { add(definition: CommandDefinitionLike): void }) => void): Promise<unknown>
  }
  session: {
    prompt(
      input: CommandInvocationLike['prompt'] & { sessionID: string; delivery?: 'steer' | 'queue' }
    ): Promise<unknown>
    /**
     * Open a session.
     *
     * `location` is the field that matters, and it is set **at create time**.
     *
     * A create with no location is born in the *server's* default directory, not
     * the caller's project — verified on the running host: with the service booted
     * from `/`, `session.create({ title })` returns `location.directory = "/"`.
     * Agents are registered per directory, so such a session cannot resolve a
     * project agent, and prompting it boots a second location for `/` — a phantom
     * workspace that outlives the session and is what the host's
     * `session.location-missing` dialog and its folder switcher trip over.
     *
     * `parentID` is deliberately absent. It links the session as a child of the
     * caller's, and a child inherits its parent's location — so a delegation issued
     * from one workspace is pinned to a directory the plugin does not control,
     * which is the same unusable-workspace failure by a different route.
     */
    create(input?: {
      title?: string
      model?: { providerID: string; id: string }
      location?: { directory: string }
    }): Promise<{ id: string; location?: { directory?: string } }>
    /** Point a session at a specific model before prompting it. */
    switchModel(input: {
      sessionID: string
      model: { providerID: string; id: string; variant?: string }
    }): Promise<void>
    /** Install an agent onto the session: its prompt, permissions and model. */
    switchAgent(input: { sessionID: string; agent: string }): Promise<void>
    /**
     * Put the session in a project directory. Must precede `switchAgent` for a project agent:
     * agents are registered per directory and the mismatch fails silently, with no error.
     *
     * A fallback for a host that ignores `create({ location })`, not the primary
     * route: moving after the fact means the session already existed in the wrong
     * project. See `create`.
     */
    move(input: { sessionID: string; directory: string }): Promise<void>
    wait(input: { sessionID: string }): Promise<void>
    /** Tear a session down, recursively including any child sessions. */
    remove(input: { sessionID: string }): Promise<void>
    get(input: {
      sessionID: string
    }): Promise<{ id: string; model?: { providerID: string; id: string }; error?: unknown }>
    hook(
      name: 'retry',
      callback: (event: RetryHookEventLike) => void,
      options?: { providerID?: string }
    ): Promise<{ dispose(): Promise<void> }>
    hook(name: 'context', callback: (event: ContextHookEventLike) => void): Promise<{ dispose(): Promise<void> }>
    /**
     * Checkpoint summaries. Fires when the host is about to compact, which is
     * the one moment a consumed receipt can be lost again — see
     * `ReceiptStore.reopen`. The event is a full session context, not just an
     * id; only the session id is read. [host-H3]
     */
    hook(name: 'compaction', callback: (event: CompactionHookEventLike) => void): Promise<{ dispose(): Promise<void> }>
    /**
     * The session transcript. Permissive on purpose: the context monitor reads `tokens` while
     * session-backed delegation reads the assistant's text out of the same payload, and typing it
     * as token records alone would force a cast where the reply is extracted.
     */
    context(input: { sessionID: string }): Promise<readonly unknown[]>
  }
  tool: {
    list(): Promise<readonly { id: string }[]>
    transform(callback: (editor: ToolEditorLike) => void): Promise<{ dispose(): Promise<void> }>
    hook(name: 'execute.after', callback: (event: ToolHookEventLike) => void): Promise<{ dispose(): Promise<void> }>
    hook(name: 'execute.before', callback: (event: ToolHookEventLike) => void): Promise<{ dispose(): Promise<void> }>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
  /**
   * Single-shot generation against a chosen model, with no session, tools or history. Used by
   * `/orchestra probe` to verify an assignment by request rather than trusting the catalog.
   */
  generate: {
    text(input: {
      prompt: string
      model?: { providerID: string; id: string; variant?: string }
    }): Promise<{ text: string }>
  }
}

export interface TokenUsageLike {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface ContextHookEventLike {
  sessionID: string
  agent: string
  model: { providerID: string; id: string; variant?: string }
  /**
   * Present only when the host sends it. The pinned SDK declares no `kind` on
   * the context hook at all — it exists on the model/http/ws request hooks, not
   * here — so filtering on it discards every event. Kept optional so an older or
   * newer host that does send one is still accepted. [host-H2]
   */
  kind?: 'primary' | 'compaction' | 'title' | 'generate'
  system: { type: string; text?: string }[]
  /** The outgoing transcript. Carries no token counts; read usage separately. */
  messages: readonly unknown[]
  options: Record<string, unknown>
}

export interface ToolEditorLike {
  namespace(namespace: { name: string; description?: string }): void
  add(tool: {
    name: string
    description?: string
    input?: unknown
    options?: Record<string, unknown>
    execute: (input: never, context?: { progress?: (update: unknown) => Promise<void> }) => Promise<unknown>
  }): void
  update(id: string, update: (tool: Record<string, unknown>) => void): void
  remove(id: string): void
}

export interface ToolHookEventLike {
  tool: string
  input: unknown
  status: 'completed' | 'error'
  sessionID: string
  agent?: string
  /**
   * Host tool-call id, correlating an `execute.after` completion with the
   * `execute.before` launch that took a slot. Required on both hooks in the
   * pinned SDK; kept optional here so the admission fallback still covers a host
   * that omits it. [host-H13]
   */
  id?: string
  /**
   * What the call produced, present on `execute.after` in the pinned SDK and
   * absent there on `execute.before` (which fires before there is a result).
   * Narrow by the hook name, not by `status`.
   */
  result?: { content?: unknown; output?: unknown; [key: string]: unknown }
  /** Set when `status` is `error`. */
  error?: unknown
}

export interface RetryHookEventLike {
  sessionID: string
  model: { providerID: string; id: string; variant?: string }
  error: { type: string; message: string; status?: number }
  /**
   * Which attempt of this logical request just failed. The host retries a
   * doomed call (~10 times over ~84s), firing this hook per attempt — so this
   * number is what keeps quarantine counting requests rather than retries.
   * Read at the one place failures are folded; everywhere else it is ignored.
   * [host-H11]
   */
  attempt: number
  decision?: { retry: boolean; delay?: number }
}

/** The session a checkpoint summary is about. Payload-free by design. */
export interface CompactionHookEventLike {
  sessionID: string
}

export interface CommandDefinitionLike {
  name: string
  description?: string
  execute(input: CommandInvocationLike): Promise<void>
}

export interface PluginDefinitionLike {
  id: string
  /**
   * `void` in the union reads as "or undefined", which is not what the host means: a plugin either
   * returns nothing or returns the cleanup function. `undefined` says that without the shorthand.
   */
  setup(ctx: PluginContextLike): Promise<undefined | (() => void)>
}
