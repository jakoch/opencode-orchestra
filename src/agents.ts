/**
 * Agent definitions for the orchestra roles.
 *
 * Permission shape follows the V2 ordered-rule model: the last matching rule
 * wins, so broad allows come first and the narrow denials follow. The read-only
 * roles deliberately re-declare the `.env` guards from the default base policy,
 * because assigning `permissions` replaces the base array rather than appending.
 */

import { ROLE_SYSTEM } from "./prompts"
import type { ModelRef, RoleName } from "./types"

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
}

export interface RoleSpec {
  id: RoleName
  name: string
  description: string
  mode: "primary" | "subagent"
  hidden: boolean
  color: string
  system: string
  permissions: PermissionRule[]
  steps?: number
}

const READ_ONLY_PERMISSIONS: PermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
]

const BUILDER_PERMISSIONS: PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "shell", resource: "git push *", effect: "ask" },
  { action: "subagent", resource: "*", effect: "allow" },
]

const SPECS: Record<RoleName, Omit<RoleSpec, "system" | "steps">> = {
  builder: {
    id: "builder",
    name: "Builder",
    description:
      "Primary orchestrator. Implements changes, runs tests, delegates exploration to scout and keeps the advisor on call for checkpoints.",
    mode: "primary",
    hidden: false,
    color: "#5b8cff",
    permissions: BUILDER_PERMISSIONS,
  },
  scout: {
    id: "scout",
    name: "Scout",
    description:
      "Fast read-only search agent. Use it to locate code, trace callers, and gather file:line evidence without loading your own context.",
    mode: "subagent",
    hidden: false,
    color: "#4cc38a",
    permissions: READ_ONLY_PERMISSIONS,
  },
  advisor: {
    id: "advisor",
    name: "Advisor",
    description:
      "Strong reasoning reviewer with read-only access. Call it at checkpoints: repeated failures, architectural tradeoffs, or before finishing.",
    mode: "subagent",
    hidden: false,
    color: "#b07cff",
    permissions: READ_ONLY_PERMISSIONS,
  },
}

export interface RoleSpecOptions {
  /** Hide the advisor so it stays out of `@`-mention listings. */
  hideAdvisor?: boolean
  /** Optional step ceiling per role, applied on top of the spec defaults. */
  steps?: Partial<Record<RoleName, number>>
}

export function roleSpec(role: RoleName, options: RoleSpecOptions = {}): RoleSpec {
  const spec = SPECS[role]
  const steps = options.steps?.[role]
  return {
    ...spec,
    hidden: role === "advisor" ? (options.hideAdvisor ?? spec.hidden) : spec.hidden,
    system: ROLE_SYSTEM[role]!,
    // Copy the rules: the agent registry mutates the array it is handed when it
    // normalizes permissions, and transform callbacks replay on every rebuild.
    permissions: spec.permissions.map((rule) => ({ ...rule })),
    steps,
  }
}

/** Static `agents` block for users who prefer a plain `opencode.jsonc`. */
export function staticAgentBlock(specs: RoleSpec[], models: Record<RoleName, ModelRef | undefined>) {
  const agents: Record<string, unknown> = {}
  for (const spec of specs) {
    const model = models[spec.id]
    agents[spec.id] = {
      description: spec.description,
      mode: spec.mode,
      ...(spec.hidden ? { hidden: true } : {}),
      ...(spec.color ? { color: spec.color } : {}),
      ...(spec.steps ? { steps: spec.steps } : {}),
      ...(model
        ? {
            model:
              model.variant ? `${model.providerID}/${model.id}#${model.variant}` : `${model.providerID}/${model.id}`,
          }
        : {}),
      system: spec.system,
      permissions: spec.permissions,
    }
  }
  return agents
}