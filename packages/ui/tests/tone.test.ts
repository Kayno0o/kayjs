import { join } from 'node:path'
import { Glob } from 'bun'
import { expect, test } from 'bun:test'

const SRC = join(import.meta.dir, '..', 'src')
const TONES = new Set(['neutral', 'accent', 'success', 'warning', 'danger', 'info'])
const TONE_LITERAL = /'(?:neutral|accent|success|warning|danger|info|muted)'/
// A prop or field declared as `tone?: ...`, `tones?: ...` or `cells: ...`, whose type may run over several lines.
const TONE_FIELD = /^\s*(?:tones?|cells)\??:(.*)$/
const ONE_VALUE = /^\s*'[a-z]+',$/
const STRING = /'[^']*'|"[^"]*"|`[^`]*`/g
const RECIPE_TONE = /\btone: \{/
// The part names of a tone group that colours several parts, as Stat's `{ value: 'text-accent' }`.
const SPELLED_ELSEWHERE = new Set(['value', 'delta', 'root', 'icon', 'label', 'bar'])

// tone.ts holds the union itself and sparkline.ts its deprecated alias.
const files = [...new Glob('*.{kay,ts}').scanSync(SRC)].filter(file => file !== 'tone.ts' && file !== 'sparkline.ts').toSorted()

test('a component takes the exported Tone, not a union of its own', async () => {
  const own: string[] = []

  for (const file of files) {
    const lines = (await Bun.file(join(SRC, file)).text()).split('\n')

    for (const [at, line] of lines.entries()) {
      const field = TONE_FIELD.exec(line)

      if (!field)
        continue

      // The type goes on while a line ends in, or the next one starts with, a union bar.
      let type = field[1]!

      for (let next = at + 1; (/[|&]\s*$/).test(lines[next - 1]!) || (/^\s*[|&]/).test(lines[next] ?? ''); next++)
        type += lines[next]

      // `tone: 'danger',` sets a value in an object, never a type of one word.
      if (TONE_LITERAL.test(type) && !ONE_VALUE.test(type))
        own.push(`${file}:${at + 1}`)
    }
  }

  expect(own).toEqual([])
})

test('every recipe tone variant lists all of the tones', async () => {
  const missing: string[] = []
  let seen = 0

  for (const file of files) {
    const text = await Bun.file(join(SRC, file)).text()
    const start = text.search(RECIPE_TONE)

    if (start === -1 || !text.slice(0, start).includes('recipe('))
      continue

    // The group runs to its closing brace, on one line or several.
    let depth = 0
    let end = start

    for (let at = text.indexOf('{', start); at < text.length; at++) {
      if (text[at] === '{')
        depth++
      else if (text[at] === '}')
        depth--

      if (depth === 0) {
        end = at

        break
      }
    }

    seen++
    const group = text.slice(start, end)
    // The keys of the group are its tones, none more: a string value could hold a colon, so the strings go first.
    const keys = [...group.slice(group.indexOf('{') + 1).replace(STRING, '\'\'').matchAll(/(\w+)\s*:/g)].map(match => match[1]!)

    for (const key of keys) {
      if (!TONES.has(key) && !SPELLED_ELSEWHERE.has(key))
        missing.push(`${file}: extra ${key}`)
    }

    for (const tone of TONES) {
      if (!new RegExp(String.raw`\b${tone}:`).test(group))
        missing.push(`${file}: ${tone}`)
    }
  }

  expect(seen).toBeGreaterThanOrEqual(6)
  expect(missing).toEqual([])
})

test('the stylesheet colours every status tone of a button and an icon button', async () => {
  const css = await Bun.file(join(SRC, 'theme.css')).text()

  for (const tone of ['success', 'warning', 'danger', 'info']) {
    expect(css, tone).toContain(`.kui-btn-${tone} {`)
    expect(css, tone).toContain(`[data-tone='${tone}']`)
  }
})
