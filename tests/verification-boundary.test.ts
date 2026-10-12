/**
 * The verification boundary, asserted rather than described.
 *
 * `docs/roles.md` states who may verify what.
 *
 * The load-bearing claim is structural: scout and advisor cannot run a check, so
 * their findings are unbacked by construction and the builder must be the one
 * allowed to settle them.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { roleSpec } from '../src/agents'

const rolesDoc = readFileSync(fileURLToPath(new URL('../docs/roles.md', import.meta.url)), 'utf8')
const evidenceSrc = readFileSync(fileURLToPath(new URL('../src/evidence.ts', import.meta.url)), 'utf8')
const quarantineSrc = readFileSync(fileURLToPath(new URL('../src/quarantine.ts', import.meta.url)), 'utf8')

/** Last matching rule wins, so the effective verdict is the final rule. */
function effectiveEffect(role: 'scout' | 'advisor' | 'builder', action: string): string | undefined {
  const rules = roleSpec(role).permissions.filter(rule => rule.action === action)
  return rules.at(-1)?.effect
}

describe('read-only roles cannot verify', () => {
  // This is the fact the whole boundary rests on. If it ever changes, the rule
  // in docs/roles.md is wrong and needs rewriting rather than assuming.
  for (const role of ['scout', 'advisor'] as const) {
    test(`${role} is denied shell`, () => {
      expect(effectiveEffect(role, 'shell')).toBe('deny')
    })

    test(`${role} is denied edit`, () => {
      expect(effectiveEffect(role, 'edit')).toBe('deny')
    })

    test(`${role} cannot nest another agent`, () => {
      expect(effectiveEffect(role, 'subagent')).toBe('deny')
    })
  }

  test('the builder may run anything, so it can settle a claim', () => {
    expect(effectiveEffect('builder', '*')).toBe('allow')
    expect(effectiveEffect('builder', 'shell')).not.toBe('deny')
  })
})

describe('the boundary is written down', () => {
  test('docs/roles.md states who may verify what', () => {
    expect(rolesDoc).toContain('verification boundary')
    expect(rolesDoc).toMatch(/may re-verify/i)
  })

  test('the rule resolves the handoff contradiction deliberately', () => {
    expect(rolesDoc).toContain('a handoff is not completion')
    expect(rolesDoc).toContain('findings are structurally unbacked')
    expect(rolesDoc).toMatch(/only the builder can settle that/i)
  })

  test('advisory is never a gate', () => {
    expect(rolesDoc).toMatch(/nothing blocks on it|never be the last word|advisory, full stop/i)
  })

  test('both decision sites reference the boundary', () => {
    // src/quarantine.ts and src/evidence.ts are where "verified" is decided.
    expect(evidenceSrc).toContain('docs/roles.md')
    expect(quarantineSrc).toContain('docs/roles.md')
  })

  test('quarantine says it classifies lifetime, not fault ownership', () => {
    // The distinction the retry gate depends on.
    expect(quarantineSrc).toMatch(/not fault ownership/i)
  })
})
