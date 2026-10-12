// Repository-root entry point.
//
// OpenCode discovers plugin *package directories* under `.opencode/plugins/`
// (per project) and `~/.config/opencode/plugins/` (global) by their root entry,
// and loads `plugin/index.ts` only when a config entry points at `./plugin`
// explicitly. This re-export is what lets a clone, a symlink, or
// `opencode plugin add github:jakoch/opencode-orchestra` work with no config
// file at all.
export { default } from './plugin/index.ts'
