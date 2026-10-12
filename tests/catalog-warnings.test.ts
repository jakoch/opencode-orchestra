/**
 * Catalog warnings.
 *
 * The assignment table reads as conclusive: three roles, three models, each
 * chosen for a stated reason. None of it mentions that every candidate came
 * from one provider, that a session model overrides the pick, or that some
 * models were refused outright. Each of those has made the table wrong while
 * looking right, which is what these warnings exist to say out loud.
 */

import { describe, expect, test } from 'bun:test'
import { renderReport } from '../src/report'
import { resolveRoles } from '../src/roles'
import { model } from './fixture'

const CATALOG = [model('flash-free', 0, 0, { name: 'flash' }), model('deep-free', 0, 0, { name: 'deep' })]

function render(warnings?: string[], sessionDefault?: string) {
  return renderReport({
    resolved: resolveRoles({ catalog: CATALOG }),
    applied: {},
    pinPath: 'p',
    pinStatus: 'pinned',
    sessionDefault,
    defaultModelEnabled: false,
    warnings
  })
}

describe('catalog warnings', () => {
  test('a single-provider catalog is called out', () => {
    const text = render(['Every candidate comes from one provider (`anthropic`).'])
    expect(text).toContain('Worth knowing')
    expect(text).toContain('one provider')
  })

  test('a session model that overrides the pick is called out', () => {
    const text = render(["The session runs on `other/model`, not the builder's `anthropic/flash-free`."], 'other/model')
    expect(text).toContain('session runs on')
  })

  test('refused models are reported as session-scoped, not as exclusions', () => {
    // The distinction matters: a global block would blacklist a model that
    // works in the TUI.
    const text = render(['1 model(s) were refused from this host and are excluded for this session only.'])
    expect(text).toContain('session only')
  })

  test('no warnings means no section at all', () => {
    // An empty section would train the reader to skip it.
    expect(render(undefined)).not.toContain('Worth knowing')
    expect(render([])).not.toContain('Worth knowing')
  })
})
