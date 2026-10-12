/**
 * Namespaced tool names.
 *
 * The host namespaces tools by joining segments with underscores, and the
 * plugin's own tools are registered under an `orchestra` namespace. Splitting on
 * the *first* underscore broke on any namespace that itself contained one,
 * which is the difference between the fan-out gate governing a tool and
 * silently not governing it.
 */

import { describe, expect, test } from 'bun:test'
import { effectiveToolId } from '../src/evidence'

describe('effectiveToolId', () => {
  test('returns a bare name unchanged', () => {
    expect(effectiveToolId('subagent')).toBe('subagent')
    expect(effectiveToolId('read')).toBe('read')
  })

  test('strips a single-segment namespace', () => {
    expect(effectiveToolId('orchestra_scout')).toBe('scout')
    expect(effectiveToolId('acme_greeting')).toBe('greeting')
  })

  test('strips a multi-segment namespace to the last part', () => {
    // The regression: splitting on the first underscore left
    // `orchestra_subagent`, which matches no gate and no write-tool set.
    expect(effectiveToolId('plugins_orchestra_subagent')).toBe('subagent')
    expect(effectiveToolId('a_b_c_write')).toBe('write')
  })

  test('keeps the tool this plugin registers', () => {
    // The delegation tools are namespaced under `orchestra`.
    expect(effectiveToolId('orchestra_scout')).toBe('scout')
    expect(effectiveToolId('orchestra_advisor')).toBe('advisor')
  })

  test('does not mangle names that merely contain an underscore', () => {
    expect(effectiveToolId('multi_patch')).toBe('patch')
    expect(effectiveToolId('multi_edit')).toBe('edit')
  })
})
