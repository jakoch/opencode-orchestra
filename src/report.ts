/**
 * Report rendering.
 *
 * The report is the user-facing half of the resolver: which model landed in each
 * role, what it beat, and what the detector had to assume. It is written to be
 * pasted into a session prompt, so it stays compact.
 */

import { roleSpec } from './agents'
import { score } from './roles'
import type { ResolveOutput, RoleName } from './types'

/**
 * Display order, not assignment order.
 *
 * Separate from `ROLES` because the two answer different questions: `ROLES` is
 * what the resolver iterates, this is the order a person reads the table in —
 * the roles that do the work first, the ones that judge it last.
 */
const ROLE_ORDER: RoleName[] = ['builder', 'scout', 'advisor', 'skeptic']
const SOURCE_LABEL: Record<string, string> = {
  override: 'plugin option',
  pin: 'pinned',
  detected: 'detected',
  fallback: 'fallback'
}
/**
 * What is known about the model, as opposed to where it came from.
 *
 * `unverified` is the default and the point of the whole exercise: the catalog
 * listing a model as active is a claim, not a result, until a request has been
 * made.
 */
const VERIFICATION_LABEL: Record<string, string> = {
  verified: 'answers',
  refused: 'REFUSED at request time',
  unknown: 'unverified'
}
const APPLIED_LABEL: Record<string, string> = {
  created: 'from plugin',
  'model-only': 'yours, model retargeted',
  skipped: 'yours, untouched'
}

function modelLabel(assignment: { model?: { providerID: string; id: string; variant?: string } }): string {
  if (!assignment.model) return 'session model (nothing detected)'
  const base = `${assignment.model.providerID}/${assignment.model.id}`
  return assignment.model.variant ? `${base}#${assignment.model.variant}` : base
}

/**
 * What the report is actually about: what each role runs on right now.
 *
 * The quarantine and rejection lists cover every model the store has ever seen
 * a failure for, which is a much longer set than "the models in use". Only the
 * second is an open risk; the first is background.
 */
function assignedRefs(resolved: ResolveOutput): Set<string> {
  const refs = new Set<string>()
  for (const assignment of Object.values(resolved.assignments)) {
    const model = assignment?.model
    if (model) refs.add(`${model.providerID}/${model.id}`)
  }
  return refs
}

/**
 * The subset of `lines` naming a model a role is currently running.
 *
 * With nothing assigned there is no background to hide: the failure list is the
 * only explanation of why no model was detected, so everything is kept.
 *
 * A line whose ref cannot be read is **kept** too. The filter exists to shorten
 * the default report, and a line this cannot classify is more likely to be the
 * one that mattered — dropping it would be shortening by omission.
 */
function forAssigned(lines: readonly string[], assigned: ReadonlySet<string>): string[] {
  if (!assigned.size) return [...lines]
  return lines.filter(line => {
    const ref = /^`([^`]+)`/.exec(line)?.[1]
    return ref === undefined || assigned.has(ref)
  })
}

export interface ReportInput {
  resolved: ResolveOutput
  /** Per-role note about how the agent definition was applied. */
  applied?: Partial<Record<RoleName, 'created' | 'model-only' | 'skipped'>>
  pinPath?: string
  pinStatus?: string
  /** The plugin's own version, printed as a diagnostics line. Absent in tests that do not care. */
  version?: string
  /** Append the full candidate table, for tuning the weights. */
  verbose?: boolean
  /** Model new sessions start on, as `provider/id`. */
  sessionDefault?: string
  /** True when the plugin is allowed to set the session default itself. */
  defaultModelEnabled?: boolean
  /** Models dropped from detection after provider failures. */
  quarantine?: string[]
  /** Models the provider refuses from here, kept in detection on purpose. */
  rejected?: string[]
  /**
   * Measured counts, already phrased by `describeTelemetry`.
   *
   * Behind `verbose` only: the default report answers "what is running and what
   * is risky", and counters are for a question about the plugin itself.
   */
  diagnostics?: string[]
  /**
   * Warnings about the shape of the catalog, not about any one role.
   *
   * A separate channel because these are the conditions under which every
   * assignment below rests on less evidence than it appears to: one provider,
   * one family, or a session model that overrides whatever was picked.
   */
  warnings?: string[]
  /** Live per-session runtime signals: evidence, loops, context pressure. */
  signals?: string[]
  /**
   * Advisory claims, already phrased by `EvidenceStore.describeClaims`.
   *
   * Rendered inside "This session" rather than as a section of their own, and
   * not in `warnings`: a claim is a fact about this session — what a role said
   * and what backs it — which is what that section is for, while `warnings` is
   * about the catalog and belongs to whoever assembles it. A separate heading
   * would also read as a verdict on the roles, and no claim here is one.
   */
  claims?: string[]
}

export function renderReport(input: ReportInput): string {
  const { resolved } = input
  const lines: string[] = []
  const detected = resolved.candidates.length

  lines.push(`## Orchestra: ${detected} tool-capable model${detected === 1 ? '' : 's'} detected`)
  lines.push('')
  lines.push('| Role | Model | Chosen by | Prompt & permissions |')
  lines.push('| --- | --- | --- | --- |')
  for (const role of ROLE_ORDER) {
    const assignment = resolved.assignments[role]
    if (!assignment) continue
    const applied = input.applied?.[role]
    const source = SOURCE_LABEL[assignment.source] ?? assignment.source
    const prompt = applied ? (APPLIED_LABEL[applied] ?? applied) : '-'
    // "detected" says where a model came from, not whether it works. A model
    // that has never answered still reads as healthy here, which is the exact
    // illusion this whole investigation ran into: the table said "detected" for
    // a model that refused every call.
    const check = VERIFICATION_LABEL[assignment.verification ?? 'unknown']
    lines.push(`| ${roleSpec(role).name} | \`${modelLabel(assignment)}\` | ${source} — ${check} | ${prompt} |`)
  }

  for (const role of ROLE_ORDER) {
    const assignment = resolved.assignments[role]
    if (!assignment) continue
    lines.push('')
    lines.push(`### ${roleSpec(role).name} — \`${modelLabel(assignment)}\``)
    for (const reason of assignment.reasons) lines.push(`- ${reason}`)
    if (assignment.runnersUp.length) {
      const alts = assignment.runnersUp
        .map(entry => `\`${entry.model.ref}\` (${(entry.score * 100).toFixed(0)})`)
        .join(', ')
      lines.push(`- Also considered: ${alts}`)
    }
    if (assignment.sharedWith?.length) {
      const others = assignment.sharedWith.map(role => roleSpec(role).name).join(', ')
      lines.push(`- Shares a model with: ${others}`)
    }
    // Say it in prose too: the table is read once, this is read when debugging.
    if ((assignment.verification ?? 'unknown') !== 'verified') {
      lines.push(
        assignment.verification === 'refused'
          ? '- **This model refused a real request.** Run `/orchestra probe`, or pin a model that answers.'
          : '- Not verified by request: the catalog says this model is available, but nothing has asked it. `/orchestra probe` checks.'
      )
    }
  }

  if (input.verbose && resolved.candidates.length) {
    lines.push('')
    lines.push('### All candidates')
    lines.push('| Model | Speed | Reason | Coding | Cheap | Ctx | Out | New | Scout | Builder | Advisor |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const model of [...resolved.candidates].sort((a, b) => b.reasoning - a.reasoning)) {
      const pct = (value: number) => (value * 100).toFixed(0)
      lines.push(
        `| \`${model.ref}\` | ${pct(model.speed)} | ${pct(model.reasoning)} | ${pct(model.coding)} | ${pct(
          model.cheapness
        )} | ${pct(model.context)} | ${pct(model.outputLimit)} | ${pct(model.recency)} | ${pct(
          score(model, 'scout')
        )} | ${pct(score(model, 'builder'))} | ${pct(score(model, 'advisor'))} |`
      )
    }
  }

  if (resolved.notes.length) {
    lines.push('')
    lines.push('### Assumptions')
    for (const note of resolved.notes) lines.push(`- ${note}`)
  }

  if (input.warnings?.length) {
    lines.push('')
    lines.push('### Worth knowing')
    for (const warning of input.warnings) lines.push(`- ${warning}`)
  }

  if (input.verbose && input.diagnostics?.length) {
    lines.push('')
    lines.push('### Measured this session')
    for (const entry of input.diagnostics) lines.push(`- ${entry}`)
  }

  // Quarantine and rejection are background about models nobody is running.
  // Gated on `verbose` in full; the default keeps only the entries naming a
  // role's current model, because "the model in use is refused here" is an open
  // risk and "three other models are" is a footnote.
  //
  // The two stay distinct: a rejection is not a quarantine. The model is still
  // eligible and still chosen, and saying so is the whole point.
  const assigned = assignedRefs(resolved)
  const quarantineLines = input.verbose ? (input.quarantine ?? []) : forAssigned(input.quarantine ?? [], assigned)
  const rejectedLines = input.verbose ? (input.rejected ?? []) : forAssigned(input.rejected ?? [], assigned)

  if (quarantineLines.length) {
    lines.push('')
    lines.push('### Quarantined models')
    lines.push(
      'Dropped from detection after failing against the provider. They stay out until the record ages out, so a withdrawn model is not re-picked tomorrow.'
    )
    if (!input.verbose) lines.push('Shown: the ones a role is currently running. `/orchestra all` lists the rest.')
    for (const entry of quarantineLines) lines.push(`- ${entry}`)
  }

  if (rejectedLines.length) {
    lines.push('')
    lines.push('### Rejected models')
    lines.push(
      'The provider refuses these here while the catalog still lists them as active and tool-capable. ' +
        'They stay in detection on purpose — the same model works inside the OpenCode TUI — so every ' +
        'plugin-driven request to one will fail until you pin a different model for that role.'
    )
    if (!input.verbose) lines.push('Shown: the ones a role is currently running. `/orchestra all` lists the rest.')
    for (const entry of rejectedLines) lines.push(`- ${entry}`)
  }

  if (input.signals?.length || input.claims?.length) {
    lines.push('')
    lines.push('### This session')
    for (const entry of input.signals ?? []) lines.push(`- ${entry}`)
    for (const entry of input.claims ?? []) lines.push(`- ${entry}`)
  }

  // A session's own model selection beats the agent's, so a mismatch here is the
  // difference between "the builder runs on the detected model" and it does not.
  const builder = resolved.assignments.builder?.model
  const builderRef = builder ? `${builder.providerID}/${builder.id}` : undefined
  if (builderRef && input.sessionDefault && input.sessionDefault !== builderRef) {
    lines.push('')
    lines.push(
      `### Session model\n` +
        `New sessions start on \`${input.sessionDefault}\`, not the builder's \`${builderRef}\`. ` +
        `A session's model wins over an agent's, so the builder will run on the session model.\n` +
        `- Fix it per session: /model, or \`opencode run --model ${builderRef}\`\n` +
        `- Fix it for the project: add \`"model": "${builderRef}"\` to opencode.jsonc, or set \`"defaultModel": true\` in the plugin options`
    )
  } else if (builderRef && input.defaultModelEnabled) {
    lines.push('')
    lines.push(`New sessions start on the detected builder model, \`${builderRef}\`.`)
  }

  lines.push('')
  lines.push(
    input.pinStatus
      ? `Pin file (${input.pinPath}): ${input.pinStatus}`
      : `No pin file. Run /orchestra-pin to freeze this assignment into ${input.pinPath ?? '.opencode/orchestra.json'}.`
  )
  if (input.version) {
    lines.push('')
    lines.push(`Plugin version: \`${input.version}\``)
  }
  return lines.join('\n')
}
