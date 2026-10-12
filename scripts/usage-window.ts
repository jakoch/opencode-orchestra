/**
 * Prints the usage window the "keep or cut" decisions are waiting on.
 *   bun scripts/usage-window.ts [path]
 * The reading is in `src/usage-window.ts`; this only loads the trace and prints.
 * Opt-in trace only: with `debug: false` there is no file.
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_TRACE_PATH } from '../src/trace'
import { compactionVerdict, gatesCanBeJudged, summarise } from '../src/usage-window'

const path = process.argv[2] ?? DEFAULT_TRACE_PATH

let text: string
try {
  text = readFileSync(path, 'utf8')
} catch {
  console.error(`No trace at ${path}.`)
  console.error('Run with debug: true to record one — an unwritten window is not an empty one.')
  process.exit(1)
}

const window = summarise(text)
if (!window.runs.length) {
  console.error(`No telemetry lines in ${path}. ${window.lines} line(s) present.`)
  console.error('`telemetry` is written on /orchestra, so a run with no report has no line.')
  process.exit(1)
}

console.log(`Usage window from ${path}`)
console.log(`  ${window.runs.length} run(s) with a report, ${window.lines} trace line(s)`)
console.log('')

console.log('Admission refusals by dimension')
// A gate can only refuse a launch that happened, so zero refusals against zero
// launches is not "the gate is unused" — it is "nothing ran", which is the one
// reading that must not reach a deletion decision.
const attempted = window.totals.dispatches
if (!gatesCanBeJudged(window)) {
  for (const [dimension, count] of Object.entries(window.totals.gates)) {
    console.log(
      `  ${dimension.padEnd(9)} ${String(count).padStart(5)}   ` +
        `${attempted} launch(es) recorded: too few for this to mean anything`
    )
  }
} else {
  for (const [dimension, count] of Object.entries(window.totals.gates)) {
    const verdict = count === 0 ? 'never refused: strongest deletion candidate' : 'in use'
    console.log(`  ${dimension.padEnd(9)} ${String(count).padStart(5)}   ${verdict}`)
  }
}
console.log('')

console.log('Receipts across compaction')
console.log(`  ${window.totals.compactions} compaction(s), ${window.totals.reopened} receipt(s) re-opened`)
console.log(`  ${compactionVerdict(window)}`)
console.log('')

console.log('Cost centres')
console.log(
  `  ${window.totals.dispatches} dispatch(es), ${window.totals.fellBack} fell back, ` +
    `${window.totals.probes} probe(s), ${window.totals.panels} panel(s)`
)
console.log('')
console.log('A zero here is evidence about a window that was recorded, not a licence to cut.')
