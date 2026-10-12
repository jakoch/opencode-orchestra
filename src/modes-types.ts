/**
 * The mode vocabulary, kept apart from what a mode does.
 *
 * `prompts.ts` needs the type and the default to build the builder's prompt,
 * and `modes.ts` needs to know a mode to decide the role set. Splitting the
 * names out is what lets those two depend on a type rather than on each other:
 * the alternative is a cycle between the prompt and the policy that shapes it,
 * which resolves by import order and breaks whenever the file order changes.
 */

export const OPERATING_MODES = ['minimal', 'standard', 'strict'] as const
export type OperatingMode = (typeof OPERATING_MODES)[number]

/**
 * The mode used when none is given, and when the given one is not a mode.
 *
 * `standard` rather than a failure: an unknown string in a config file should
 * not stop the plugin loading, and silently falling back to the behaviour the
 * user already had is the least surprising thing available.
 */
export const DEFAULT_MODE: OperatingMode = 'standard'

export function isOperatingMode(value: unknown): value is OperatingMode {
  return typeof value === 'string' && (OPERATING_MODES as readonly string[]).includes(value)
}
