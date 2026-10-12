/**
 * Pin file support. Detection is live day to day, which is wrong in CI: a provider upgrade can
 * silently move a role to a different model. The pin file freezes the assignment and is read at
 * startup with detection as the fallback.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelRef, ResolveOutput, RoleName } from './types'

export const DEFAULT_PIN_PATH = '.opencode/orchestra.json'

export interface PinFile {
  generator: 'opencode-orchestra'
  updated: string
  catalog?: { models: number }
  roles: Partial<Record<RoleName, { model: string; variant?: string }>>
}

function refToSelector(ref: ModelRef): { model: string; variant?: string } {
  const model = `${ref.providerID}/${ref.id}`
  return ref.variant ? { model, variant: ref.variant } : { model }
}

/** Reads a pin file, tolerating a missing or malformed file. */
export function readPin(path: string): PinFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PinFile
    if (!parsed || typeof parsed !== 'object' || !parsed.roles) return null
    return parsed
  } catch {
    return null
  }
}

export function buildPin(
  resolved: ResolveOutput,
  modelsSeen: number,
  roles: readonly RoleName[] = Object.keys(resolved.assignments) as RoleName[]
): PinFile {
  const pinned: PinFile['roles'] = {}
  for (const role of roles) {
    const model = resolved.assignments[role]?.model
    if (model) pinned[role] = refToSelector(model)
  }
  return {
    generator: 'opencode-orchestra',
    updated: new Date().toISOString(),
    catalog: { models: modelsSeen },
    roles: pinned
  }
}

export function writePin(path: string, pin: PinFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`, 'utf8')
}

/** Pretty JSON for pasting into `opencode.jsonc`. */
export function toJsonc(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
