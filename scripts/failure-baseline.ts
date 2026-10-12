/**
 * Prints the classifier's verdict for every message in the corpus.
 * Run before changing `src/failure.ts` and diff the output.
 * The recorded baseline is what `tests/failure-classes.test.ts` asserts against.
 * A scratch tool, not a test — kept so the comparison can be regenerated.
 */

import { classifyProbeError } from '../src/probe'
import { classifyFailure, isCredentialRefusal, looksLikeTransportFault } from '../src/quarantine'
import { isUnclearOutcome } from '../src/receipts'

/** Real provider messages seen on this install, plus the boundaries between classes. */
export const CORPUS: string[] = [
  // free-tier / credential refusal
  "Subagent failed: OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
  "OpenCode's free tier must be used from within opencode",
  'free plan can only be used by OpenCode',
  'this model must be used inside the OpenCode app',
  'credential can only be used within opencode',
  // model lifetime
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
  // rate limiting
  'Rate limit exceeded. Please try again later.',
  'Too many requests',
  'quota exceeded for this key',
  'HTTP 429',
  // connection level
  'ECONNREFUSED 127.0.0.1:11434',
  'read ECONNRESET',
  'connect ETIMEDOUT 10.0.0.1:443',
  'write EPIPE',
  'getaddrinfo EAI_AGAIN api.openai.com',
  'socket hang up',
  'fetch failed',
  'proxy error: tunnel failed',
  // interruption (word forms, distinct from errno forms)
  'request timed out after 300000ms',
  'The operation was aborted',
  'stream cancelled by the user',
  'request interrupted',
  'stream ended unexpectedly',
  'session closed while waiting',
  'connection aborted by server',
  'operation cancelled',
  // service-side, not the model's fault
  'server error 500',
  'internal error upstream',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'model overloaded, try again',
  // unrecognised
  'the agent produced no reply',
  'agent not registered in this directory',
  'prompt is required',
  ''
]

const rows = CORPUS.map(message => ({
  message: message.slice(0, 58),
  quarantine: classifyFailure({ message }),
  transportFault: looksLikeTransportFault({ message }),
  credentialRefusal: isCredentialRefusal({ message }),
  probe: classifyProbeError(new Error(message)).verdict,
  probeKind: classifyProbeError(new Error(message)).kind ?? '-',
  receiptUnclear: isUnclearOutcome(message)
}))

// biome-ignore lint/suspicious/noConsole: this is the tool that prints the baseline
console.table(rows)
