/**
 * Guards the host-behavior inventory against rot.
 *
 * `src/host-facts.ts` stops the *types* drifting; this stops the *document*
 * drifting: every `[host-NN]` tag needs a table row, every row's file:line
 * must still resolve, and every `live` row must carry a date. Pure file reads,
 * no host needed. See `docs/host-behavior.md` for the grading rule.
 */
import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const read = (path: string): Promise<string> => readFile(new URL(path, root), 'utf8')

async function sources(): Promise<string[]> {
  const entries = await readdir(new URL('src', root))
  const plugin = await readdir(new URL('plugin', root))
  return [
    ...entries.filter(name => name.endsWith('.ts')).map(name => `src/${name}`),
    ...plugin.filter(name => name.endsWith('.ts')).map(name => `plugin/${name}`),
    'index.ts'
  ]
}

describe('host-behavior inventory', () => {
  test('every [host-NN] tag has a table row', async () => {
    const doc = await read('docs/host-behavior.md')
    const rows = new Set([...doc.matchAll(/^\|\s*(H\d+)\s*\|/gm)].map(match => match[1]))
    const tags = new Set<string>()
    for (const file of await sources()) {
      for (const match of (await read(file)).matchAll(/\[host-(H\d+)\]/g)) tags.add(match[1]!)
    }
    for (const tag of tags) expect(rows.has(tag), `tag [host-${tag}] has no row`).toBe(true)
  })

  test("every row's file:line resolves", async () => {
    const doc = await read('docs/host-behavior.md')
    for (const line of doc.split('\n')) {
      if (!line.startsWith('|')) continue
      for (const match of line.matchAll(/`([\w./-]+\.tsx?)(?::(\d+))?`/g)) {
        const [, file, row] = match
        const text = await read(file!)
        if (row !== undefined) {
          expect(text.split('\n').length, `${file}:${row}`).toBeGreaterThanOrEqual(Number(row))
        }
      }
    }
  })

  test('every live row carries a date', async () => {
    const doc = await read('docs/host-behavior.md')
    for (const line of doc.split('\n')) {
      if (!line.startsWith('|')) continue
      const cells = line.split('|').map(cell => cell.trim())
      if (cells.length < 6 || !/live/.test(cells[4]!)) continue
      expect(line, `live row without a date: ${cells[1]}`).toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  test('host-facts is never imported at runtime', async () => {
    for (const file of await sources()) {
      if (file === 'src/host-facts.ts') continue
      const text = await read(file)
      expect(text, `${file} imports host-facts`).not.toContain('host-facts')
    }
  })
})
