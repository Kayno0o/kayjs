import type { DevResult } from './dev'
import type { Variant } from './sites'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { devSection, freshLogs, restartsIn } from './dev'

const MEMORY = { pss: 200 * 1024 * 1024, rss: 300 * 1024 * 1024, processes: 3 }

function variant(kind: Variant['kind']): Variant {
  return { site: { name: 'bakery', repo: '', astro: '', pages: [] }, kind, dir: '', devDir: '', ports: { backend: 0, http: 0, https: 0, dev: 0 } }
}

function result(software: string, edits: DevResult['edits']): DevResult {
  return { software, cold: [{ ms: 900, cpu: 1500 }], warm: [{ ms: 400, cpu: 600 }, { ms: 380, cpu: 640 }, { ms: 420, cpu: 620 }], loads: [{ ms: 1200, cpu: 800, requests: 30 }], idle: [4], edits, rest: [MEMORY], edited: [MEMORY] }
}

describe('restartsIn', () => {
  it('sums the restarts kay dev logged, and reads none from output without one', () => {
    expect(restartsIn('18:16:16 src/routes/tarifs.kay: restarted in 252 ms\n18:16:17 src/app.css and 1 more: restarted in 48 ms\n')).toBe(300)
    expect(restartsIn('[vite] page reload src/pages/menu.astro\n')).toBeUndefined()
  })
})

describe('freshLogs', () => {
  it('removes the last server\'s logs, which a new one would only write over from their start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-bench-logs-'))

    writeFileSync(join(dir, 'dev.out.log'), 'src/routes/tarifs.kay: restarted in 200 ms\n')
    writeFileSync(join(dir, 'dev.err.log'), '')
    freshLogs(dir)

    expect(existsSync(join(dir, 'dev.out.log'))).toBe(false)
    expect(existsSync(join(dir, 'dev.err.log'))).toBe(false)
    expect(() => freshLogs(dir)).not.toThrow()
  })
})

describe('devSection', () => {
  it('names each dev server, and splits the restarts off the edits that logged one', () => {
    const astro = { ms: 60, by: 'itself' as const, kept: false, cpu: 40 }
    const kay = (ms: number, restart?: number) => ({ ms, by: 'itself' as const, kept: true, field: ms !== 320, restart, cpu: ms * 2 })
    const section = devSection(new Map([
      [variant('astro'), result('Astro 6.4.6', { template: [astro], style: [astro], server: [{ ...astro, by: 'reload' }] })],
      [variant('kay'), result('kay 1.38.0, the registry', { template: [kay(300, 250), kay(320, 270), kay(310)], style: [kay(90)], server: [kay(330, 280)] })],
    ])).join('\n')

    expect(section).toContain('|  | bakery astro | bakery kay |')
    expect(section).toContain('| dev server | Astro 6.4.6 | kay 1.38.0, the registry |')
    expect(section).toContain('| startup, warm (ms) | 400 (380 to 420); CPU 620 | 400 (380 to 420); CPU 620 |')
    expect(section).toContain('| template edit to screen (ms) | 60.0 (60.0 to 60.0); CPU 40.0 | 310 (300 to 320); CPU 620 |')
    expect(section).toContain('| of which server restart (ms) | none logged | 260 (250 to 270), in 2 of 3 |')
    expect(section).toContain('| server code edit to screen (ms) | never by itself; 60.0 (60.0 to 60.0) from a reload by hand; CPU 40.0 | 330 (330 to 330); CPU 660 |')
    expect(section).toContain('| CPU while the edit page sits open 2 s (ms) | 4.0 (4.0 to 4.0) | 4.0 (4.0 to 4.0) |')
    expect(section).toContain('| page state kept through the edit (template / style / server) | 0 / 0 / 0 of 1 | 3 / 1 / 1 of 3 |')
    expect(section).toContain('| form field value kept (template / style / server) | no text field on the edit page | 2 / 1 / 1 of 3 |')
    expect(section).toContain('| memory at rest, PSS (RSS) | 200 (300), 3 processes | 200 (300), 3 processes |')
  })

  it('writes nothing without a site to edit', () => {
    expect(devSection(new Map())).toEqual([])
  })
})
