#!/usr/bin/env bun
/**
 * Live host-fact probe. Deliberately NOT `*.test.ts`, and gated on
 * `ORCHESTRA_LIVE=1` plus an `opencode` binary, so CI skips it silently. It is
 * the only thing that keeps the `live` rows of `docs/host-behavior.md` honest.
 *
 * What it checks (deterministic, no model turns — a headless model call is a
 * free-tier lottery, so anything needing one is out of scope by design):
 *   H4  bare session create lands in the server default, not the project
 *   H5  plugin state via /api/plugin (incl. surfacing `Duplicate plugin ID`)
 *   H7  GET /api/agent serializes (a broken registry shape 400s)
 *   H10 root entry vs ./plugin resolution, read off the plugin list
 *   registration control: our commands are present (command transform works)
 *
 * Prints the table as JSON. `--update` rewrites the Checked-on cells of the
 * rows it verified. Exit 0 on pass-or-skip, 1 on any failed check.
 *
 * Usage: ORCHESTRA_LIVE=1 bun tests/live.probe.ts [--update] [--port 54399]
 */
import { readFile, writeFile } from 'node:fs/promises'

const DOC = new URL('../docs/host-behavior.md', import.meta.url).pathname

interface Row {
  id: string
  claim: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
}

const rows: Row[] = []
const pass = (id: string, claim: string, detail = ''): void => {
  rows.push({ id, claim, detail, status: 'pass' })
}
const fail = (id: string, claim: string, detail = ''): void => {
  rows.push({ id, claim, detail, status: 'fail' })
}

function args(): { update: boolean; port: number } {
  const argv = process.argv.slice(2)
  const portIndex = argv.indexOf('--port')
  return {
    update: argv.includes('--update'),
    port: portIndex >= 0 ? Number(argv[portIndex + 1]) || 54399 : 54399
  }
}

async function main(): Promise<void> {
  if (!process.env.ORCHESTRA_LIVE) {
    console.log('skip: set ORCHESTRA_LIVE=1 to run the live host probe')
    return
  }
  const opencode = Bun.which('opencode')
  if (!opencode) {
    console.error('FAIL: no `opencode` binary on PATH')
    process.exit(1)
  }
  const { update, port } = args()
  const project = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

  // Booted from `/` on purpose: H4 is about where a location-less session
  // lands, so the server default must not be the project itself.
  const server = Bun.spawn([opencode, 'serve', '--port', String(port)], {
    cwd: '/',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  try {
    const started = await waitForListening(server, port)
    if (!started) fail('boot', 'private server boots', 'no listening line within 20s')
    else {
      const auth = `Basic ${btoa(`opencode:${started.password}`)}`
      const api = async (path: string, init?: RequestInit) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          ...init,
          headers: { authorization: auth, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
          signal: AbortSignal.timeout(15000)
        })
        return response
      }

      // Location boot: plugin setup runs on first location use, not at boot.
      const plugins = await (await api(`/api/plugin?location%5Bdirectory%5D=${project}`)).json()
      const entries = (plugins?.data ?? []).filter((p: { id?: string }) => p?.id === 'opencode-orchestra')
      if (!entries.length) fail('H10', 'plugin resolves for the project', 'no opencode-orchestra entry')
      else {
        pass(
          'H10',
          'plugin resolves for the project',
          entries.map((p: { source?: { path?: string } }) => p?.source?.path ?? '?').join(',')
        )
        for (const entry of entries) {
          const state = entry?.state?.status
          if (state !== 'active')
            fail(
              'H5',
              'single active registration',
              `${entry?.source?.path}: ${state} ${entry?.state?.error ?? ''}`.trim()
            )
          else pass('H5', 'single active registration', String(entry?.source?.path ?? ''))
        }
      }

      const agents = await api(`/api/agent?location%5Bdirectory%5D=${project}`)
      if (agents.status === 200) pass('H7', 'agent list serializes', 'GET /api/agent → 200')
      else
        fail('H7', 'agent list serializes', `GET /api/agent → ${agents.status} ${(await agents.text()).slice(0, 120)}`)

      const commands = await (await api(`/api/command?location%5Bdirectory%5D=${project}`)).json()
      const names = (commands?.data ?? []).map((c: { name?: string }) => c?.name)
      if (names.includes('orchestra-probe')) pass('control', 'command transform registers', 'orchestra-probe present')
      else fail('control', 'command transform registers', `names: ${names.slice(0, 8).join(',')}`)

      const bare = await (
        await api('/api/session', { method: 'POST', body: JSON.stringify({ title: 'live-probe' }) })
      ).json()
      const dir = bare?.data?.location?.directory
      if (dir === '/') pass('H4', 'bare create lands in server default', 'location.directory = "/"')
      else fail('H4', 'bare create lands in server default', `location.directory = ${JSON.stringify(dir)}`)
      const owned = await (
        await api('/api/session', {
          method: 'POST',
          body: JSON.stringify({ directory: project, title: 'live-probe' })
        })
      ).json()
      await api(`/api/session/${owned?.data?.id ?? 'missing'}/delete`, { method: 'DELETE' }).catch(() => undefined)
      await api(`/api/session/${bare?.data?.id ?? 'missing'}/delete`, { method: 'DELETE' }).catch(() => undefined)
    }
  } finally {
    server.kill()
  }

  console.log(JSON.stringify(rows, null, 2))
  if (update) await rewriteCheckedOn(rows)
  if (rows.some(row => row.status === 'fail')) {
    console.error('\n1+ live checks failed — see rows above')
    process.exit(1)
  }
}

async function waitForListening(
  server: ReturnType<typeof Bun.spawn>,
  port: number
): Promise<{ password: string } | null> {
  const stdout = server.stdout
  if (!(stdout instanceof ReadableStream)) return null
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const listening = buffer.match(/server listening on http:\/\/127\.0\.0\.1:(\d+)/)
    const password = buffer.match(/server password (\S+)/)
    if (listening?.[1] === String(port) && password?.[1]) {
      reader.releaseLock()
      return { password: password[1] }
    }
  }
  reader.releaseLock()
  return null
}

/** Rewrites the Checked-on cells of verified rows to today. Minimal on purpose. */
async function rewriteCheckedOn(done: Row[]): Promise<void> {
  const verified = new Set(done.filter(row => row.status === 'pass' && /^H\d+$/.test(row.id)).map(row => row.id))
  if (!verified.size) return
  const today = new Date().toISOString().slice(0, 10)
  const lines = (await readFile(DOC, 'utf8')).split('\n')
  const next = lines.map(line => {
    if (!line.startsWith('|')) return line
    const cells = line.split('|').map(cell => cell.trim())
    if (cells.length < 7 || !verified.has(cells[1]!)) return line
    cells[5] = `${today}, live probe`
    return `| ${cells.slice(1, -1).join(' | ')} |`
  })
  await writeFile(DOC, `${next.join('\n')}`)
  console.log(`updated Checked-on for: ${[...verified].join(', ')}`)
}

void main()
