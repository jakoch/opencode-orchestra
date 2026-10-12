/**
 * Reading a usage window out of a trace.
 *
 * The "keep or cut" decisions need a count over a window of real use, and the
 * counters that produce one are process-local: `DispatchTelemetry` is rebuilt on
 * every plugin load, so a single `/orchestra` can only ever report on the run
 * that opened it. The trace JSONL is the one record that appends *across*
 * restarts, which makes it the only place a window can be read from.
 *
 * The trap is that these counters are **cumulative per process**. Three reports
 * in one session write 1, 2, then 3 — so summing the lines multiplies a busy
 * session's activity by its report frequency, and the sessions you most want to
 * look at are the ones that get inflated most. The rule is therefore: take one
 * line per process (its final total), then sum across processes.
 *
 * Pure and separate from the printer that displays it, because the aggregation
 * is where a wrong answer is invisible — a double-counted window still looks
 * like a table of plausible numbers.
 *
 * `gatesCanBeJudged` guards the same failure one level up: this module shipped
 * once with a gate verdict that read "strongest deletion candidate" off a
 * window containing no launches at all. The aggregation was correct; the
 * *conclusion* drawn from it was not, and nothing tested the conclusion.
 */

export interface UsageRun {
  dispatches: number
  fellBack: number
  elapsedTotalMs: number
  /** `session/model/provider`, from the trace's single packed field. */
  gateRefusals: [number, number, number]
  compactions: number
  receiptsReopened: number
  probes: number
  panels: number
}

export interface UsageWindow {
  runs: UsageRun[]
  /** Trace lines considered, so a reader can tell "no data" from "no activity". */
  lines: number
  totals: {
    dispatches: number
    fellBack: number
    gates: { session: number; model: number; provider: number }
    compactions: number
    reopened: number
    probes: number
    panels: number
  }
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** One trace line's counters, or `undefined` when the line is not telemetry. */
function readLine(line: string): (UsageRun & { pid?: number }) | undefined {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    // A truncated final line is expected: the trace writes synchronously and a
    // full disk loses the last few. Skipping one beats failing the whole read.
    return undefined
  }
  if (parsed.event !== 'telemetry') return undefined
  const [session, model, provider] = String(parsed.gateRefusals ?? '0/0/0')
    .split('/')
    .map(part => number(part))
  return {
    pid: parsed.pid === undefined ? undefined : number(parsed.pid),
    dispatches: number(parsed.dispatches),
    fellBack: number(parsed.fellBack),
    elapsedTotalMs: number(parsed.elapsedTotalMs),
    gateRefusals: [session ?? 0, model ?? 0, provider ?? 0],
    // Absent on traces written before the compaction counter existed. Zero and
    // unrecorded are the same number here, and the report says so rather than
    // implying receipts survived when the file simply predates the field.
    compactions: number(parsed.compactions),
    receiptsReopened: number(parsed.receiptsReopened),
    probes: number(parsed.probes),
    panels: number(parsed.panels)
  }
}

/** Builds the window. `text` is the whole JSONL, truncated tail and all. */
export function summarise(text: string): UsageWindow {
  const lines = text.split('\n').filter(Boolean)
  const entries: (UsageRun & { pid?: number })[] = []
  for (const line of lines) {
    const entry = readLine(line)
    if (entry) entries.push(entry)
  }

  // One line per process: its last report is its total. Cumulatives only rise
  // within a process, so the larger of two is the safer keep — a truncated tail
  // must not shrink a run.
  const byPid = new Map<string, UsageRun & { pid?: number }>()
  for (const [index, entry] of entries.entries()) {
    // A pidless line gets a key of its own so it counts as its own run.
    // Over-counting a repeated report is recoverable; dropping a run would read
    // as evidence the mechanism was never used, which is the failure this
    // whole module exists to prevent.
    const key = entry.pid === undefined ? `no-pid-${index}` : `pid-${entry.pid}`
    const seen = byPid.get(key)
    if (!seen) byPid.set(key, entry)
    else byPid.set(key, entry.dispatches >= seen.dispatches ? entry : seen)
  }
  const runs = [...byPid.values()]

  const add = (pick: (run: UsageRun) => number) => runs.reduce((sum, run) => sum + pick(run), 0)
  const gates = runs.reduce(
    (sum, run) => ({
      session: sum.session + run.gateRefusals[0],
      model: sum.model + run.gateRefusals[1],
      provider: sum.provider + run.gateRefusals[2]
    }),
    { session: 0, model: 0, provider: 0 }
  )

  return {
    runs,
    lines: lines.length,
    totals: {
      dispatches: add(run => run.dispatches),
      fellBack: add(run => run.fellBack),
      gates,
      compactions: add(run => run.compactions),
      reopened: add(run => run.receiptsReopened),
      probes: add(run => run.probes),
      panels: add(run => run.panels)
    }
  }
}

/**
 * The one sentence each blocked decision turns on.
 *
 * Returns nothing when the window cannot support a verdict — no compactions
 * means persistence is neither justified nor disproved, and saying so is more
 * useful than a zero that reads like a result.
 */
export function compactionVerdict(window: UsageWindow): string {
  const { compactions, reopened } = window.totals
  if (compactions === 0) return 'no compactions recorded: persistence is neither justified nor disproved'
  if (reopened === 0) return 'none lost to compaction: persistence could be cut to session-bound'
  return 'receipts have been lost and re-offered: persistence is doing real work'
}

/**
 * Whether this window can support a gate-deletion decision at all.
 *
 * A gate refuses a *launch*, so a window with no launches has nothing to report
 * — and "no refusals" from such a window reads exactly like "the gate is never
 * needed", which is the conclusion it cannot support. One busy session that hit
 * the limit once and one that never launched at all both produce zeros; only one
 * of them is evidence.
 *
 * So the gate section refuses to render a verdict below a floor of launches. The
 * floor is deliberately low — three — because this is about "was the gate ever
 * in a position to fire", not about a statistically meaningful sample.
 */
export function gatesCanBeJudged(window: UsageWindow): boolean {
  return window.totals.dispatches >= 3
}
