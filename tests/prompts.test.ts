/**
 * Contract tests for the role prompts.
 *
 * The prompts are plain text with no assertions on them, so `docs/roles.md`
 * could claim "the prompt makes delegation explicit" while nothing checked it.
 * These tests assert the *load-bearing content* — that each role still carries
 * the instruction it exists to enforce — not the exact wording, so a legitimate
 * rewrite does not produce noise but a dropped contract does fail.
 *
 * What each prompt must keep:
 * - builder: names `scout` AND gives a trigger condition for calling it, plus a
 *   non-empty advisor checkpoint list. A prompt that merely mentions the scout
 *   without saying when to use it is the bug these tests exist to prevent.
 * - scout: states it is read-only and returns `path:line` references.
 * - advisor: states it never implements and asks for a verdict.
 * - skeptic: stays adversarial. Unlike the other read-only roles it does
 *   not use the four-section envelope — it argues, and its verdict scale is
 *   deliberately disjoint from the advisor's.
 * - both read-only roles: name the four handoff sections, in order, and say a
 *   short answer may skip an empty one. The envelope is enforced by the prompt
 *   and nowhere else, so if the wording goes the type in `src/types.ts` becomes
 *   a description of something no role is asked to produce.
 */

import { describe, expect, test } from 'bun:test'
import { ADVISOR_SYSTEM, BUILDER_SYSTEM, ROLE_SYSTEM, SCOUT_SYSTEM, SKEPTIC_SYSTEM } from '../src/prompts'
import { type FileRef, HANDOFF_CONFIDENCE, type HandoffEnvelope, ROLES } from '../src/types'

/** The envelope sections, in the order both prompts declare them. */
const ENVELOPE_SECTIONS = ['FINDINGS', 'FILES', 'CONFIDENCE', 'OPEN QUESTIONS'] as const

/** Index of a section label (`- FINDINGS: ...`) at the start of a line. */
function sectionIndex(prompt: string, section: string): number {
  return prompt.search(new RegExp(`^- ${section}:`, 'm'))
}

describe('builder prompt', () => {
  test('names the scout as a delegation target', () => {
    expect(BUILDER_SYSTEM).toContain('scout')
  })

  test('gives a trigger condition, not just a mention', () => {
    // The failure this guards against: "You delegate reading to the scout" reads
    // as philosophy, so a model reaches for its own tools instead. The contract
    // needs an explicit "when you need X, do Y".
    const triggerPhrases = ['whenever you need', 'when you need', 'before you', 'do not search', 'is not your job']
    const hasTrigger = triggerPhrases.some(phrase => BUILDER_SYSTEM.toLowerCase().includes(phrase))
    expect(hasTrigger).toBe(true)
  })

  test('tells the model how to phrase a scout request', () => {
    // Precise questions with file:line references are the scout's whole output
    // contract; without this in the builder prompt the scout gets vague asks.
    expect(BUILDER_SYSTEM).toMatch(/file:line|path:line/)
  })

  test('keeps a non-empty advisor checkpoint list', () => {
    expect(BUILDER_SYSTEM).toContain('advisor')
    const checkpointSection = BUILDER_SYSTEM.split('Checkpoints')[1]
    expect(checkpointSection).toBeDefined()
    // Four checkpoints are listed; any positive count guards the contract without
    // freezing the exact list.
    const bullets = (checkpointSection ?? '').match(/^\s*-\s/gm) ?? []
    expect(bullets.length).toBeGreaterThan(0)
  })

  test('keeps the advisor checkpoint trigger scenarios', () => {
    expect(BUILDER_SYSTEM).toMatch(/failed twice/i)
    expect(BUILDER_SYSTEM).toMatch(/finished|done/i)
  })

  test('says a handoff is not completion, and bounds where re-checking may go', () => {
    expect(BUILDER_SYSTEM).toMatch(/handoff is not completion/i)
    expect(BUILDER_SYSTEM).toMatch(/re-running a verification command/i)
    expect(BUILDER_SYSTEM).toMatch(/re-running the scout's searches is not/i)
  })
})

describe('scout prompt', () => {
  test('states it is read-only', () => {
    expect(SCOUT_SYSTEM).toMatch(/read-only/i)
  })

  test('returns file:line references, not transcripts', () => {
    expect(SCOUT_SYSTEM).toMatch(/path:line|file:line/)
    expect(SCOUT_SYSTEM).toMatch(/never dump|not transcripts/i)
  })

  test("bounds the response so the caller's context is protected", () => {
    expect(SCOUT_SYSTEM).toMatch(/at most|three sentences|most five lines/i)
  })

  test('names the handoff sections in order, without changing the output shape', () => {
    expect(sectionIndex(SCOUT_SYSTEM, 'FINDINGS')).toBeGreaterThan(-1)
    expect(SCOUT_SYSTEM).toMatch(/FINDINGS:.*in at most three sentences/i)
    expect(SCOUT_SYSTEM).toMatch(/worth knowing/i)
  })
})

describe('advisor prompt', () => {
  test('states it never implements', () => {
    expect(ADVISOR_SYSTEM).toMatch(/never implement|never writes|read-only/i)
  })

  test('requires a verdict token', () => {
    expect(ADVISOR_SYSTEM).toMatch(/VERDICT/)
    expect(ADVISOR_SYSTEM).toMatch(/approve/)
    expect(ADVISOR_SYSTEM).toMatch(/block/)
  })

  test('keeps the verdict first and the findings capped at five bullets', () => {
    // The envelope is additive: VERDICT still leads, because a checkpoint whose
    // verdict is the fourth paragraph is a checkpoint nobody scans.
    expect(sectionIndex(ADVISOR_SYSTEM, 'VERDICT')).toBeLessThan(sectionIndex(ADVISOR_SYSTEM, 'FINDINGS'))
    expect(ADVISOR_SYSTEM).toMatch(/FINDINGS: at most five bullets/i)
    expect(ADVISOR_SYSTEM).toMatch(/one or two high-level directions/i)
  })
})

describe('handoff envelope', () => {
  test('both read-only roles name all four sections, in the same order', () => {
    for (const prompt of [SCOUT_SYSTEM, ADVISOR_SYSTEM]) {
      const positions = ENVELOPE_SECTIONS.map(section => sectionIndex(prompt, section))
      expect(positions).not.toContain(-1)
      // The declared order is part of the contract: a consumer reads top-down.
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    }
  })

  test('the sections are a soft edge, not a checklist to satisfy', () => {
    // The failure this guards against is a padded empty section: a scout that
    // writes "OPEN QUESTIONS: none" on every call spends the caller's tokens to
    // say nothing, and a rigid contract makes that the cheaper answer.
    for (const prompt of [SCOUT_SYSTEM, ADVISOR_SYSTEM]) {
      expect(prompt).toMatch(/leave out any that would be empty/i)
      expect(prompt).toMatch(/a short answer that skips an empty section is a good answer/i)
    }
    // FILES is the section most likely to become a duplication tax, since both
    // roles already cite refs inline. It must stay droppable. `[^\n]` rather
    // than `[\s\S]` on purpose: a greedy match walks into the next section and
    // passes on the wrong line's wording, which is how this assertion was
    // verified to be useless.
    expect(SCOUT_SYSTEM).toMatch(/FILES:[^\n]*leave it out when/i)
    expect(ADVISOR_SYSTEM).toMatch(/FILES:[^\n]*leave it out when/i)
  })

  test('confidence is one of the three words the type allows', () => {
    // Asserted against the type rather than a hardcoded list, so widening
    // `HandoffConfidence` without asking the model for it fails here.
    for (const prompt of [SCOUT_SYSTEM, ADVISOR_SYSTEM]) {
      for (const word of HANDOFF_CONFIDENCE) expect(prompt).toContain(`\`${word}\``)
    }
  })

  test('bounds the type where TypeScript can, and documents where it cannot', () => {
    // These two assertions are compile-time: `bun run typecheck` is what runs
    // them, and an unused `@ts-expect-error` fails the build. The runtime lines
    // keep the suite honest about what it is claiming to check.
    const ref: FileRef = 'src/types.ts:144'
    expect(ref).toContain(':')
    // @ts-expect-error a bare path is not a `path:line` reference
    const barePath: FileRef = 'src/types.ts'
    expect(barePath).not.toContain(':')

    const confident: HandoffEnvelope['confidence'] = 'low'
    expect(HANDOFF_CONFIDENCE).toContain(confident)
    // @ts-expect-error confidence is a closed union, not free text
    const certain: HandoffEnvelope['confidence'] = 'certain'
    expect(typeof certain).toBe('string')
  })
})

describe('ROLE_SYSTEM map', () => {
  test('exposes every role prompt', () => {
    // Built from ROLES rather than written out: a literal list of three prompts
    // silently stopped covering the map the moment a fourth role landed, which
    // is the failure this test exists to prevent.
    expect(Object.keys(ROLE_SYSTEM).sort()).toEqual([...ROLES].sort())
  })

  test('maps each role to its prompt', () => {
    expect(ROLE_SYSTEM.builder).toBe(BUILDER_SYSTEM)
    expect(ROLE_SYSTEM.scout).toBe(SCOUT_SYSTEM)
    expect(ROLE_SYSTEM.advisor).toBe(ADVISOR_SYSTEM)
    expect(ROLE_SYSTEM.skeptic).toBe(SKEPTIC_SYSTEM)
  })

  test('the skeptic is adversarial and the advisor is not', () => {
    // The two review the same proposal and must not read the same. If the
    // skeptic's mandate ever softens into the advisor's, the panel becomes one
    // opinion in two voices and the whole role stops earning its cost.
    expect(ROLE_SYSTEM.skeptic).toMatch(/zero sycophancy/i)
    expect(ROLE_SYSTEM.skeptic).toMatch(/never open with validation/i)
    expect(ROLE_SYSTEM.advisor).not.toMatch(/zero sycophancy/i)
  })

  test('the skeptic answers the three questions nobody else asks', () => {
    // The role's reason to exist, in the words the caller relies on. Losing any
    // one of these narrows it back toward the advisor.
    for (const question of ['SHOULD WE BUILD THIS AT ALL', 'WHY THIS WAY', 'CAN IT BE SIMPLER']) {
      expect(ROLE_SYSTEM.skeptic).toContain(question)
    }
  })

  test('the skeptic is told a clean proposal is a valid result', () => {
    // Without this the critic has to invent an objection to justify its
    // existence, and the panel gets a finding that was manufactured to fill a
    // section. The exact escape-hatch wording matters: a paraphrase is not
    // something a model can match.
    expect(ROLE_SYSTEM.skeptic).toMatch(/fundamentally sound/i)
    expect(ROLE_SYSTEM.skeptic).toMatch(/no invented findings/i)
  })

  test('the skeptic always reports a verdict, a flaw verdict and a confidence', () => {
    // Absence is ambiguous — an omitted section could mean "none" or "did not
    // check" — so these three are mandatory and the rest are not.
    expect(ROLE_SYSTEM.skeptic).toMatch(
      /except \*\*VERDICT\*\*, \*\*FATAL FLAW\*\* and \*\*CONFIDENCE\*\*, which are always present/i
    )
    expect(ROLE_SYSTEM.skeptic).toMatch(/omit it entirely/i)
  })

  test('the skeptic asks for exactly three stress tests', () => {
    // Five questions get ignored; the count is part of what makes them read.
    expect(ROLE_SYSTEM.skeptic).toMatch(/exactly three numbered questions/i)
  })

  test("the skeptic's verdict scale is disjoint from the advisor's", () => {
    // Overlapping verdicts invite a false consensus: two roles emitting the
    // same word look like they agree rather than like they were asked different
    // questions.
    //
    // Asserted against the VERDICT line rather than the whole prompt. A bare
    // `not.toContain('block')` fails on "nothing is blocked by it", which is
    // the skeptic being advisory — the opposite of what this test is checking.
    const verdicts = (prompt: string) => prompt.match(/^- (?:\*\*)?VERDICT(?:\*\*)?: (.+)$/m)?.[1] ?? ''
    for (const verdict of ['drop', 'reshape', 'simplify']) {
      expect(verdicts(ROLE_SYSTEM.skeptic)).toContain(verdict)
      expect(verdicts(ROLE_SYSTEM.advisor)).not.toContain(verdict)
    }
    expect(verdicts(ROLE_SYSTEM.advisor)).toContain('block')
    expect(verdicts(ROLE_SYSTEM.skeptic)).not.toContain('block')
  })

  test('the skeptic stays advisory', () => {
    expect(ROLE_SYSTEM.skeptic).toMatch(/advisory|nothing waits on your verdict/i)
  })

  test('no prompt is empty', () => {
    for (const [role, prompt] of Object.entries(ROLE_SYSTEM)) {
      expect(prompt.length).toBeGreaterThan(0)
    }
  })
})
