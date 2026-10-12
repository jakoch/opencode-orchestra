/**
 * One failure classifier, two action policies.
 *
 * The corpus is the point: 46 real messages, recorded against the previous
 * implementation and asserted here. A classifier that changes a verdict nobody
 * asked about is the same failure this file exists to end.
 */

import { describe, expect, test } from 'bun:test'
import { classify, type FailureClass, isWorthRetrying } from '../src/failure'
import { classifyProbeError } from '../src/probe'
import { classifyFailure, isCredentialRefusal, looksLikeTransportFault } from '../src/quarantine'
import { isUnclearOutcome as receiptUnclear } from '../src/receipts'

/** Real provider messages from this install, plus the boundaries between classes. */
const CORPUS: string[] = [
  "Subagent failed: OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
  "OpenCode's free tier must be used from within opencode",
  'free plan can only be used by OpenCode',
  'this model must be used inside the OpenCode app',
  'credential can only be used within opencode',
  'model deprecated',
  'Model exo-free has been deprecated.',
  'no such model',
  'unknown model: gpt-9',
  'model_not_found',
  'Endpoint is unavailable.',
  'this model is not available',
  'does not exist',
  'model removed from catalog',
  'model retired',
  'Upstream request failed: Model is unavailable.',
  'Rate limit exceeded. Please try again later.',
  'Too many requests',
  'quota exceeded for this key',
  'HTTP 429',
  'ECONNREFUSED 127.0.0.1:11434',
  'read ECONNRESET',
  'connect ETIMEDOUT 10.0.0.1:443',
  'write EPIPE',
  'getaddrinfo EAI_AGAIN api.openai.com',
  'socket hang up',
  'fetch failed',
  'proxy error: tunnel failed',
  'request timed out after 300000ms',
  'The operation was aborted',
  'stream cancelled by the user',
  'request interrupted',
  'stream ended unexpectedly',
  'session closed while waiting',
  'connection aborted by server',
  'operation cancelled',
  'server error 500',
  'internal error upstream',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'model overloaded, try again',
  'the agent produced no reply',
  'agent not registered in this directory',
  'prompt is required',
  ''
]

describe('the corpus classifies as intended', () => {
  // Typed, because `test.each` widens an inline table's literal unions to
  // `string` and the expectation then stops being checked at all.
  const EXPECTED: [number, FailureClass][] = [
    [0, 'rejected'],
    [1, 'rejected'],
    [2, 'rejected'],
    [3, 'rejected'],
    [4, 'rejected'],
    [5, 'withdrawn'],
    [6, 'withdrawn'],
    [7, 'withdrawn'],
    [8, 'withdrawn'],
    [9, 'withdrawn'],
    [10, 'withdrawn'],
    [11, 'withdrawn'],
    [12, 'withdrawn'],
    [13, 'withdrawn'],
    [14, 'withdrawn'],
    [15, 'withdrawn'],
    [16, 'rate_limited'],
    [17, 'rate_limited'],
    [18, 'rate_limited'],
    [19, 'rate_limited'],
    [20, 'transport'],
    [21, 'transport'],
    [22, 'transport'],
    [23, 'transport'],
    [24, 'transport'],
    [25, 'transport'],
    [26, 'transport'],
    [27, 'transport'],
    [28, 'interrupted'],
    [29, 'interrupted'],
    [30, 'interrupted'],
    [31, 'interrupted'],
    [32, 'interrupted'],
    [33, 'interrupted'],
    [34, 'interrupted'],
    [35, 'interrupted'],
    [36, 'unavailable'],
    [37, 'unavailable'],
    [38, 'unavailable'],
    [39, 'unavailable'],
    [40, 'interrupted'],
    [41, 'unavailable'],
    [42, 'task'],
    [43, 'task'],
    [44, 'task'],
    [45, 'task']
  ]

  test.each(EXPECTED)('row %i is %s', (row, expected) => {
    expect(classify(CORPUS[row])).toBe(expected)
  })
})

describe('the three callers now agree, where they previously did not', () => {
  test('a credential refusal is a refusal in both, not terminal in one', () => {
    // The bug: `probe.ts` carried only the `can only be used` phrasing, so the
    // `must be used` wording — also observed on this install — came back
    // `kind: terminal` and retired a working model from detection.
    for (const message of CORPUS.slice(0, 5)) {
      expect(classifyFailure({ message })).toBe('rejected')
      expect(classifyProbeError(new Error(message)).kind).toBe('rejected')
      expect(isCredentialRefusal({ message })).toBe(true)
    }
  })

  test('a connection fault is not a verdict on the model', () => {
    // The bug: `EPIPE`, `EAI_AGAIN`, `fetch failed` and `proxy error` fell
    // through `probe.ts`'s `NOT_ABOUT_THE_MODEL` to its default, which is a
    // verdict on the model. A local proxy hiccup was retiring a model globally.
    for (const message of [CORPUS[23], CORPUS[24], CORPUS[26], CORPUS[27]]) {
      expect(classifyProbeError(new Error(message)).verdict).toBe('unverified')
    }
  })

  test('a user cancellation is not a verdict on the model', () => {
    for (const message of [CORPUS[30], CORPUS[31], CORPUS[33], CORPUS[35]]) {
      expect(classifyProbeError(new Error(message)).verdict).toBe('unverified')
    }
  })

  test('a withdrawn model is retired, rather than retried forever', () => {
    // The bug: `TRANSPORT_FAULT_PATTERNS` knew these were model identity and
    // `TERMINAL_PATTERNS` did not, so `classifyFailure` returned `ignore` and
    // nothing was ever blocked.
    for (const message of [CORPUS[9], CORPUS[13], CORPUS[14]]) {
      expect(classifyFailure({ message })).toBe('terminal')
    }
  })

  test('a service outage does not retire a model', () => {
    // `TERMINAL_PATTERNS` matched the bare word `unavailable`, so a gateway
    // outage read as a withdrawn model. The subject is what tells them apart.
    expect(classifyFailure({ message: CORPUS[39] })).toBe('ignore')
    expect(classifyProbeError(new Error(CORPUS[39]!)).verdict).toBe('unverified')
  })
})

describe('action policies, which deliberately disagree', () => {
  test('a rate limit is not worth retrying but is not a model fault', () => {
    // The next-best model is usually the same provider on the same key, and a
    // retry doubles the wait.
    expect(isWorthRetrying(CORPUS[16])).toBe(false)
    expect(classifyProbeError(new Error(CORPUS[16]!)).verdict).toBe('unverified')
  })

  test('a timeout is worth neither retrying nor blaming', () => {
    // The two predicates disagree on purpose, and this is where they do.
    expect(isWorthRetrying(CORPUS[28])).toBe(false)
    // A receipt must not call a timeout a failure: that asserts an outcome
    // nobody observed.
    expect(receiptUnclear(CORPUS[28])).toBe(true)
  })

  test('a withdrawn model is worth walking past, not retrying on', () => {
    expect(isWorthRetrying(CORPUS[14])).toBe(true)
  })

  test('the quarantine alias and the classifier agree, and the two policies do not', () => {
    // The exported names the modules already used must behave identically to the
    // unified classifier, or the consolidation changed something silently.
    for (const message of CORPUS) {
      const text = message ?? ''
      expect(looksLikeTransportFault({ message: text })).toBe(isWorthRetrying(text))
    }
    // The second pair disagrees *on purpose*, and the corpus is where that is
    // pinned: walking past a model is a routing decision, "never observed" is an
    // epistemic one, and collapsing them would either retry dead models or tell
    // the builder a rate limit was a verdict on the work.
    const disagreements = CORPUS.filter(m => isWorthRetrying(m) !== receiptUnclear(m))
    expect(disagreements.length).toBeGreaterThan(0)
  })
})

describe('status codes beat text', () => {
  test('404 and 410 are withdrawn whatever the message says', () => {
    expect(classify({ status: 404, message: 'free tier only' })).toBe('withdrawn')
    expect(classify({ status: 410, message: 'anything at all' })).toBe('withdrawn')
  })

  test('429 is rate_limited whatever the message says', () => {
    expect(classify({ status: 429, message: 'the model was removed' })).toBe('rate_limited')
  })

  test('an unrecognised message is a class, not a shrug', () => {
    // Never `undefined`: no caller should have to decide what "no verdict" is.
    expect(classify(undefined)).toBe('task')
    expect(classify('')).toBe('task')
  })
})
