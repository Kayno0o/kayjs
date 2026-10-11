import type { DevResult } from './dev'
import type { Variant } from './sites'
import { describe, expect, it } from 'bun:test'
import { devSection, restartsIn } from './dev'

const MEMORY = { pss: 200 * 1024 * 1024, rss: 300 * 1024 * 1024, processes: 3 }

function variant(kind: Variant['kind']): Variant {
  return { site: { name: 'bakery', repo: '', astro: '', pages: [] }, kind, dir: '', devDir: '', ports: { backend: 0, http: 0, https: 0, dev: 0 } }
}

function result(software: string, edits: DevResult['edits']): DevResult {
  return { software, cold: [900], warm: [400, 380, 420], loads: [{ ms: 1200, requests: 30 }], edits, rest: [MEMORY], edited: [MEMORY] }
}

describe('restartsIn', () => {
  it('sums the restarts kay dev logged, and reads none from output without one', () => {
    expect(restartsIn('18:16:16 src/routes/tarifs.kay: restarted in 252 ms\n18:16:17 src/app.css and 1 more: restarted in 48 ms\n')).toBe(300)
    expect(restartsIn('[vite] page reload src/pages/menu.astro\n')).toBeUndefined()
  })
})

describe('devSection', () => {
  it('names each dev server, and splits the restarts off the edits that logged one', () => {
    const astro = { ms: 60, by: 'itself' as const, kept: false }
    const kay = (ms: number, restart?: number) => ({ ms, by: 'itself' as const, kept: true, restart })
    const section = devSection(new Map([
      [variant('astro'), result('Astro 6.4.6', { template: [astro], style: [astro], server: [{ ...astro, by: 'reload' }] })],
      [variant('kay'), result('kay 1.38.0, the registry', { template: [kay(300, 250), kay(320, 270), kay(310)], style: [kay(90)], server: [kay(330, 280)] })],
    ])).join('\n')

    expect(section).toContain('|  | bakery astro | bakery kay |')
    expect(section).toContain('| dev server | Astro 6.4.6 | kay 1.38.0, the registry |')
    expect(section).toContain('| template edit to screen (ms) | 60.0 (60.0 to 60.0) | 310 (300 to 320) |')
    expect(section).toContain('| of which server restart (ms) | none logged | 260 (250 to 270), in 2 of 3 |')
    expect(section).toContain('| server code edit to screen (ms) | never by itself; 60.0 (60.0 to 60.0) from a reload by hand | 330 (330 to 330) |')
    expect(section).toContain('| page state kept through the edit (template / style / server) | 0 / 0 / 0 of 1 | 3 / 1 / 1 of 3 |')
    expect(section).toContain('| memory at rest, PSS (RSS) | 200 (300), 3 processes | 200 (300), 3 processes |')
  })

  it('writes nothing without a site to edit', () => {
    expect(devSection(new Map())).toEqual([])
  })
})
