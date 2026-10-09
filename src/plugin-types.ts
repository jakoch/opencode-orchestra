/**
 * Minimal structural types for the plugin surface this project uses.
 *
 * They mirror `@opencode/plugin`, but are declared here so the plugin loads with
 * zero installed dependencies. OpenCode reads the default export's `id` and
 * `setup`, so a plain object is a valid plugin; install `@opencode/plugin` if you
 * want the plugin entrypoint type-checked against the published contract.
 */

import type { ModelInfo } from "./types"
import type { PermissionRule } from "./agents"

export interface AgentInfoLike {
  id: string
  name: string
  model?: { providerID: string; id: string; variant?: string }
  system?: string
  description?: string
  mode?: "primary" | "subagent" | "all"
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
  default(id?: string): string | undefined
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
  delivery?: "steer" | "queue"
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
    prompt(input: CommandInvocationLike["prompt"] & { sessionID: string; delivery?: "steer" | "queue" }): Promise<unknown>
    create(input?: { title?: string }): Promise<{ id: string }>
    hook(
      name: "retry",
      callback: (event: RetryHookEventLike) => void,
      options?: { providerID?: string },
    ): Promise<{ dispose(): Promise<void> }>
    hook(
      name: "context",
      callback: (event: ContextHookEventLike) => void,
    ): Promise<{ dispose(): Promise<void> }>
    context(input: { sessionID: string }): Promise<readonly { tokens?: TokenUsageLike }[]>
  }
  tool: {
    list(): Promise<readonly { id: string }[]>
    hook(
      name: "execute.after",
      callback: (event: ToolHookEventLike) => void,
    ): Promise<{ dispose(): Promise<void> }>
    hook(name: "execute.before", callback: (event: ToolHookEventLike) => void): Promise<{ dispose(): Promise<void> }>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
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
   * Documented as present but absent on the running host, so it is optional here.
   * Do not filter on it: doing so discards every event.
   */
  kind?: "primary" | "compaction" | "title" | "generate"
  system: { type: string; text?: string }[]
  /** The outgoing transcript. Carries no token counts; read usage separately. */
  messages: readonly unknown[]
  options: Record<string, unknown>
}

export interface ToolHookEventLike {
  tool: string
  input: unknown
  status: "completed" | "error"
  sessionID: string
  agent?: string
}

export interface RetryHookEventLike {
  sessionID: string
  model: { providerID: string; id: string; variant?: string }
  error: { type: string; message: string; status?: number }
  attempt: number
  decision?: { retry: boolean; delay?: number }
}

export interface CommandDefinitionLike {
  name: string
  description?: string
  execute(input: CommandInvocationLike): Promise<void>
}

export interface PluginDefinitionLike {
  id: string
  setup(ctx: PluginContextLike): Promise<void | (() => void)>
}