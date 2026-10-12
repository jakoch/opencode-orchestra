/**
 * Operating modes.
 *
 * The failure these guard is a cost control that saves nothing: a mode that
 * only rewrote the builder's prompt would read as a reduction while leaving
 * `orchestra_advisor` registered and callable. Every test here is therefore
 * about *structure* — which tools exist — rather than about which words the
 * prompt contains.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODE, isOperatingMode, MODE_ROLES, modeRoleOverrides, OPERATING_MODES } from '../src/modes'
import { builderSystem, ROLE_SYSTEM, roleSystem } from '../src/prompts'
import { ROLES } from '../src/types'

describe('mode vocabulary', () => {
  test('there are exactly three, and default is standard', () => {
    expect([...OPERATING_MODES]).toEqual(['minimal', 'standard', 'strict'])
    // Standard is the default *because* minimal and strict are unvalidated, not
    // because it is the best mode — see `src/modes.ts`.
    expect(DEFAULT_MODE).toBe('standard')
  })

  test('an unrecognised mode is not a mode', () => {
    expect(isOperatingMode('minimal')).toBe(true)
    expect(isOperatingMode('lean')).toBe(false)
    // Config files are untyped input, so the runtime check is the only one there
    // is. A typo must not pass as a mode nobody implements.
    expect(isOperatingMode(undefined)).toBe(false)
    expect(isOperatingMode(3)).toBe(false)
  })
})

describe('a mode is structural, not advisory', () => {
  test('minimal removes both reviewers', () => {
    expect([...MODE_ROLES.minimal]).toEqual(['builder', 'scout'])
  })

  test('minimal keeps the scout', () => {
    // The WP's own hard constraint. Handoff is a core task, so Minimal means "no
    // extra reviewers" — dropping the scout would leave a builder whose
    // operating model tells it to delegate, with nothing to delegate to.
    expect(MODE_ROLES.minimal).toContain('scout')
    expect(MODE_ROLES.minimal).toContain('builder')
  })

  test('standard and strict keep every role', () => {
    // Strict adds no role. What it changes is frequency, which is advice, and
    // claiming otherwise would overstate what a mode can do.
    for (const mode of ['standard', 'strict'] as const) {
      expect([...MODE_ROLES[mode]].sort()).toEqual([...ROLES].sort())
    }
  })

  test('minimal is expressed as removal, so no tool is registered', () => {
    // The mechanism, asserted rather than assumed: `null` is what the existing
    // `roles` option already means by "do not register this", and
    // `plugin/index.ts` filters `activeRoles` on it.
    const overrides = modeRoleOverrides('minimal', undefined)
    expect(overrides.advisor).toBeNull()
    expect(overrides.skeptic).toBeNull()
    expect(overrides.scout).toBeUndefined()
    expect(overrides.builder).toBeUndefined()
  })
})

describe('an explicit roles entry beats the mode', () => {
  test('a pinned model survives a mode that would drop the role', () => {
    // Someone who writes both has said what they want. A preset that overrode
    // the specific would be a surprise with no way to see it coming.
    const overrides = modeRoleOverrides('minimal', { advisor: 'anthropic/claude-opus-4-1' })
    expect(overrides.advisor).toBe('anthropic/claude-opus-4-1')
    expect(overrides.skeptic).toBeNull()
  })

  test('an explicit null wins over a mode that keeps the role', () => {
    // The other direction: standard keeps every role, and a user who wants one
    // gone should be able to say so without leaving standard.
    const overrides = modeRoleOverrides('standard', { skeptic: null })
    expect(overrides.skeptic).toBeNull()
  })

  test('standard alone changes nothing', () => {
    // The default must be a genuine no-op. Anything else would mean every
    // existing config silently lost a role when this shipped.
    expect(modeRoleOverrides('standard', undefined)).toEqual({})
  })
})

describe('the builder prompt', () => {
  test('standard leaves the prompt exactly as it was', () => {
    // `ROLE_SYSTEM` is still exported and still the standard text, so the many
    // prompt tests keep asserting the real thing rather than a copy.
    expect(builderSystem('standard')).toBe(builderSystem())
    expect(builderSystem('standard')).not.toContain('__MODE_SECTION__')
  })

  test('the placeholder never survives into any mode', () => {
    for (const mode of OPERATING_MODES) {
      expect(builderSystem(mode)).not.toContain('__MODE_SECTION__')
    }
  })

  test('minimal adds no advisor guidance', () => {
    // Minimal removes the tool; telling the builder to use it would be advice
    // about a tool that does not exist.
    expect(builderSystem('minimal')).toBe(builderSystem('standard'))
  })

  test('strict adds guidance that admits it cannot be enforced', () => {
    const text = builderSystem('strict')
    expect(text).toContain('Strict mode')
    // The load-bearing line. Every other mode change is structural and the model
    // cannot argue with it; this one has no hook behind it, so a builder that
    // believed strict reviews commits would report a review it never ran.
    expect(text).toMatch(/recommendation, not a hook/i)
    expect(text).toMatch(/do not claim a review happened/i)
  })

  test('strict keeps everything standard says', () => {
    // Additive only. A mode that removed advice would make strict worse, not
    // stricter.
    for (const line of builderSystem('standard').split('\n')) {
      if (line.trim()) expect(builderSystem('strict')).toContain(line)
    }
  })

  test('no mode edits a reviewer prompt', () => {
    // Scout, advisor and skeptic are unchanged by any mode. Making a reviewer
    // less sceptical would be the opposite of a cost control, and the reviewer
    // prompts are module constants rather than per-mode strings precisely so
    // this cannot drift.
    const roleSystems = roleSystem('minimal')
    for (const role of ['scout', 'advisor', 'skeptic'] as const) {
      expect(roleSystems[role]).toBe(ROLE_SYSTEM[role])
      expect(roleSystem('strict')[role]).toBe(ROLE_SYSTEM[role])
    }
  })
})
