/**
 * Report rendering.
 *
 * The report is the user-facing half of the resolver: which model landed in each
 * role, what it beat, and what the detector had to assume. It is written to be
 * pasted into a session prompt, so it stays compact.
 */

import { roleSpec } from "./agents"
import { score } from "./roles"
import type { RoleName, ResolveOutput } from "./types"

const ROLE_ORDER: RoleName[] = ["builder", "scout", "advisor"]
const SOURCE_LABEL: Record<string, string> = {
  override: "plugin option",
  pin: "pinned",
  detected: "detected",
  fallback: "fallback",
}
const APPLIED_LABEL: Record<string, string> = {
  created: "from plugin",
  "model-only": "yours, model retargeted",
  skipped: "yours, untouched",
}

function modelLabel(assignment: { model?: { providerID: string; id: string; variant?: string } }): string {
  if (!assignment.model) return "session model (nothing detected)"
  const base = `${assignment.model.providerID}/${assignment.model.id}`
  return assignment.model.variant ? `${base}#${assignment.model.variant}` : base
}

export interface ReportInput {
  resolved: ResolveOutput
  /** Per-role note about how the agent definition was applied. */
  applied?: Partial<Record<RoleName, "created" | "model-only" | "skipped">>
  pinPath?: string
  pinStatus?: string
  /** Append the full candidate table, for tuning the weights. */
  verbose?: boolean
  /** Model new sessions start on, as `provider/id`. */
  sessionDefault?: string
  /** True when the plugin is allowed to set the session default itself. */
  defaultModelEnabled?: boolean
  /** Models dropped from detection after provider failures. */
  quarantine?: string[]
  /** Live per-session runtime signals: evidence, loops, context pressure. */
  signals?: string[]
}

export function renderReport(input: ReportInput): string {
  const { resolved } = input
  const lines: string[] = []
  const detected = resolved.candidates.length

  lines.push(`## Orchestra: ${detected} tool-capable model${detected === 1 ? "" : "s"} detected`)
  lines.push("")
  lines.push("| Role | Model | Chosen by | Prompt & permissions |")
  lines.push("| --- | --- | --- | --- |")
  for (const role of ROLE_ORDER) {
    const assignment = resolved.assignments[role]
    if (!assignment) continue
    const applied = input.applied?.[role]
    const source = SOURCE_LABEL[assignment.source] ?? assignment.source
    const prompt = applied ? (APPLIED_LABEL[applied] ?? applied) : "-"
    lines.push(`| ${roleSpec(role).name} | \`${modelLabel(assignment)}\` | ${source} | ${prompt} |`)
  }

  for (const role of ROLE_ORDER) {
    const assignment = resolved.assignments[role]
    if (!assignment) continue
    lines.push("")
    lines.push(`### ${roleSpec(role).name} — \`${modelLabel(assignment)}\``)
    for (const reason of assignment.reasons) lines.push(`- ${reason}`)
    if (assignment.runnersUp.length) {
      const alts = assignment.runnersUp
        .map((entry) => `\`${entry.model.ref}\` (${(entry.score * 100).toFixed(0)})`)
        .join(", ")
      lines.push(`- Also considered: ${alts}`)
    }
    if (assignment.sharedWith?.length) {
      const others = assignment.sharedWith.map((role) => roleSpec(role).name).join(", ")
      lines.push(`- Shares a model with: ${others}`)
    }
  }

  if (input.verbose && resolved.candidates.length) {
    lines.push("")
    lines.push("### All candidates")
    lines.push("| Model | Speed | Reason | Coding | Cheap | Ctx | Out | New | Scout | Builder | Advisor |")
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for (const model of [...resolved.candidates].sort((a, b) => b.reasoning - a.reasoning)) {
      const pct = (value: number) => (value * 100).toFixed(0)
      lines.push(
        `| \`${model.ref}\` | ${pct(model.speed)} | ${pct(model.reasoning)} | ${pct(model.coding)} | ${pct(
          model.cheapness,
        )} | ${pct(model.context)} | ${pct(model.outputLimit)} | ${pct(model.recency)} | ${pct(
          score(model, "scout"),
        )} | ${pct(score(model, "builder"))} | ${pct(score(model, "advisor"))} |`,
      )
    }
  }

  if (resolved.notes.length) {
    lines.push("")
    lines.push("### Assumptions")
    for (const note of resolved.notes) lines.push(`- ${note}`)
  }

  if (input.quarantine?.length) {
    lines.push("")
    lines.push("### Quarantined models")
    lines.push("Dropped from detection after failing against the provider. They stay out until the record ages out, so a withdrawn model is not re-picked tomorrow.")
    for (const entry of input.quarantine) lines.push(`- ${entry}`)
  }

  if (input.signals?.length) {
    lines.push("")
    lines.push("### This session")
    for (const entry of input.signals) lines.push(`- ${entry}`)
  }

  // A session's own model selection beats the agent's, so a mismatch here is the
  // difference between "the builder runs on the detected model" and it does not.
  const builder = resolved.assignments.builder?.model
  const builderRef = builder ? `${builder.providerID}/${builder.id}` : undefined
  if (builderRef && input.sessionDefault && input.sessionDefault !== builderRef) {
    lines.push("")
    lines.push(
      `### Session model\n` +
        `New sessions start on \`${input.sessionDefault}\`, not the builder's \`${builderRef}\`. ` +
        `A session's model wins over an agent's, so the builder will run on the session model.\n` +
        `- Fix it per session: /model, or \`opencode run --model ${builderRef}\`\n` +
        `- Fix it for the project: add \`"model": "${builderRef}"\` to opencode.jsonc, or set \`"defaultModel": true\` in the plugin options`,
    )
  } else if (builderRef && input.defaultModelEnabled) {
    lines.push("")
    lines.push(`New sessions start on the detected builder model, \`${builderRef}\`.`)
  }

  lines.push("")
  lines.push(
    input.pinStatus
      ? `Pin file (${input.pinPath}): ${input.pinStatus}`
      : `No pin file. Run /orchestra-pin to freeze this assignment into ${input.pinPath ?? ".opencode/orchestra.json"}.`,
  )
  return lines.join("\n")
}