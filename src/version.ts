/**
 * The plugin version.
 *
 * Kept as a constant rather than read from `package.json`: the host loads this
 * plugin from a clone, a symlink, or a global plugin directory, and none of
 * those guarantees a resolvable `package.json` next to the running module. Bump
 * it alongside the `package.json` version on every release, or `/orchestra
 * version` reports a lie.
 */
export const PLUGIN_VERSION = '0.1.0'
