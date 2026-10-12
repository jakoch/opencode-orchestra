/**
 * Agent definitions for the orchestra roles.
 * Permission shape follows the V2 ordered-rule model: last matching rule wins.
 * Read-only roles re-declare `.env` guards because assigning `permissions` replaces the base array.
 */

import type { OperatingMode } from './modes-types'
import { builderSystem, ROLE_SYSTEM } from './prompts'
import type { ModelRef, RoleName } from './types'

/**
 * A role's model in the shape `AgentEditor.update` hands its callback.
 * The agent registry speaks `Model.Ref` — `{id, providerID, variant}` — same as `session.switchModel`.
 * The `{providerID, model, variant}` form is the config shape (`opencode.jsonc`).
 * Writing that here leaves the registry with a model that has no `id`, causing `GET /api/agent` to fail with HTTP 400.
 * Verified against the running host, not inferred from SDK types.
 */
export function agentModel(ref: ModelRef): ModelRef {
  return { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
}

export interface PermissionRule {
  action: string
  resource: string
  effect: 'allow' | 'ask' | 'deny'
}

export interface RoleSpec {
  id: RoleName
  name: string
  description: string
  mode: 'primary' | 'subagent'
  hidden: boolean
  color: string
  system: string
  permissions: PermissionRule[]
  steps?: number
}

const READ_ONLY_PERMISSIONS: PermissionRule[] = [
  { action: 'edit', resource: '*', effect: 'deny' },
  { action: 'shell', resource: '*', effect: 'deny' },
  { action: 'question', resource: '*', effect: 'deny' },
  { action: 'subagent', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'glob', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'allow' },
  { action: 'webfetch', resource: '*', effect: 'allow' },
  { action: 'websearch', resource: '*', effect: 'allow' }
]

const BUILDER_PERMISSIONS: PermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'external_directory', resource: '*', effect: 'ask' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
  { action: 'shell', resource: 'git push *', effect: 'ask' },
  { action: 'subagent', resource: '*', effect: 'allow' }
]

const SPECS: Record<RoleName, Omit<RoleSpec, 'system' | 'steps'>> = {
  builder: {
    id: 'builder',
    name: 'Builder',
    description:
      'Primary orchestrator. Implements changes, runs tests, delegates exploration to scout and keeps the advisor on call for checkpoints.',
    mode: 'primary',
    hidden: false,
    color: '#5b8cff',
    permissions: BUILDER_PERMISSIONS
  },
  scout: {
    id: 'scout',
    name: 'Scout',
    description:
      'Fast read-only search agent. Use it to locate code, trace callers, and gather file:line evidence without loading your own context.',
    mode: 'subagent',
    hidden: false,
    color: '#4cc38a',
    permissions: READ_ONLY_PERMISSIONS
  },
  advisor: {
    id: 'advisor',
    name: 'Advisor',
    description:
      'Strong reasoning reviewer with read-only access. Call it at checkpoints: repeated failures, architectural tradeoffs, or before finishing.',
    mode: 'subagent',
    hidden: false,
    color: '#b07cff',
    permissions: READ_ONLY_PERMISSIONS
  },
  skeptic: {
    id: 'skeptic',
    name: 'Skeptic',
    description:
      'Adversarial reviewer with read-only access. Call it before committing to a design: it argues whether to build the thing at all, why it is built that way, and whether it can be simpler. Bound to a different model than the builder wherever the catalog allows.',
    mode: 'subagent',
    hidden: false,
    color: '#e8703a',
    permissions: READ_ONLY_PERMISSIONS
  }
}

export interface RoleSpecOptions {
  /**
   * Hide the on-call reviewers so they stay out of `@`-mention listings.
   * Covers both advisor and skeptic: they are the same kind of role — invoked
   * deliberately, never part of a normal turn — so hiding one and leaving the
   * other listed would advertise a review surface the user cannot see the
   * sibling of. The option keeps its name because renaming it would break every
   * existing config for no gain.
   */
  hideAdvisor?: boolean
  /** Optional step ceiling per role, applied on top of the spec defaults. */
  steps?: Partial<Record<RoleName, number>>
  /**
   * Operating mode. Only the builder's prompt reads it, and only `strict` adds
   * anything: a mode that removes a role never reaches this function at all,
   * because the role is not registered in the first place.
   */
  mode?: OperatingMode
}

/** Roles hidden by `hideAdvisor`, and nothing else. */
const ON_CALL: readonly RoleName[] = ['advisor', 'skeptic']

export function roleSpec(role: RoleName, options: RoleSpecOptions = {}): RoleSpec {
  const spec = SPECS[role]
  const steps = options.steps?.[role]
  return {
    ...spec,
    hidden: ON_CALL.includes(role) ? (options.hideAdvisor ?? spec.hidden) : spec.hidden,
    system: role === 'builder' ? builderSystem(options.mode) : ROLE_SYSTEM[role]!,
    // Copy the rules: the agent registry mutates the array it is handed when it
    // normalizes permissions, and transform callbacks replay on every rebuild.
    permissions: spec.permissions.map(rule => ({ ...rule })),
    steps
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
            model: model.variant
              ? `${model.providerID}/${model.id}#${model.variant}`
              : `${model.providerID}/${model.id}`
          }
        : {}),
      system: spec.system,
      permissions: spec.permissions
    }
  }
  return agents
}
