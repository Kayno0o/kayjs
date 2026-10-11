import type { PaletteEntry } from '../src/palette'
import { describe, expect, test } from 'bun:test'
import { paletteMatches, paletteScore, paletteSections, RECENT_GROUP, withRecent } from '../src/palette'

const link = (label: string, group: string, keywords?: string): PaletteEntry => ({ label, group, keywords, href: `/${group}/${label}`.toLowerCase().replaceAll(' ', '-') })

describe('paletteScore', () => {
  test('ranks a label prefix over a label hit, over a group or keyword hit, over characters in order', () => {
    expect(paletteScore({ label: 'Color Converter', group: 'Tools' }, 'col')).toBe(1000)
    expect(paletteScore({ label: 'QR Code Reader', group: 'Tools' }, 'code')).toBe(800)
    expect(paletteScore({ label: 'Hash Generator', group: 'Tools', keywords: 'md5 sha256' }, 'sha')).toBe(600)
    expect(paletteScore({ label: 'Steam', group: 'Pages' }, 'pages')).toBe(600)

    const subsequence = paletteScore({ label: 'Automate', group: 'Notes' }, 'atome')

    expect(subsequence).toBeGreaterThan(0)
    expect(subsequence).toBeLessThan(600)
  })

  test('reads the group before the label, so a query can name both', () => {
    expect(paletteScore({ label: 'Text', group: 'AI' }, 'aitext')).toBeGreaterThan(0)
    expect(paletteScore({ label: 'Text', group: 'Tools' }, 'aitext')).toBe(0)
  })

  test('gives 0 when a character is missing', () => {
    expect(paletteScore({ label: 'Hash Generator', group: 'Tools' }, 'zzz')).toBe(0)
  })
})

describe('paletteMatches', () => {
  test('drops what does not match and breaks ties by group order, then label', () => {
    const entries = [link('Text', 'Tools'), link('Translate', 'AI'), link('Text', 'AI'), link('Steam', 'Pages')]

    expect(paletteMatches(entries, ' T ', ['AI', 'Tools']).map(entry => `${entry.group} ${entry.label}`)).toEqual(['AI Text', 'AI Translate', 'Tools Text', 'Pages Steam'])
  })
})

describe('paletteSections', () => {
  test('lists the recent links that still exist first, then each group in order, unlisted groups last as they come', () => {
    const entries = [link('Steam', 'Pages'), link('Hash', 'Tools'), link('Groceries', 'Notes'), link('Home', 'Pages')]
    const sections = paletteSections(entries, ['/tools/hash', '/gone'], ['Pages', 'Tools'])

    expect(sections.map(section => [section.group, section.entries.map(entry => entry.label)])).toEqual([
      [RECENT_GROUP, ['Hash']],
      ['Pages', ['Steam', 'Home']],
      ['Tools', ['Hash']],
      ['Notes', ['Groceries']],
    ])
  })

  test('has no recent section when nothing recent is left', () => {
    expect(paletteSections([link('Steam', 'Pages')], ['/gone']).map(section => section.group)).toEqual(['Pages'])
  })
})

describe('withRecent', () => {
  test('moves the href to the front without repeating it, and keeps the limit', () => {
    expect(withRecent(['/a', '/b', '/c'], '/b')).toEqual(['/b', '/a', '/c'])
    expect(withRecent(['/a', '/b'], '/c', 2)).toEqual(['/c', '/a'])
  })
})
