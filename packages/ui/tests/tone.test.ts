import { join } from 'node:path'
import { Glob } from 'bun'
import { expect, test } from 'bun:test'

const SRC = join(import.meta.dir, '..', 'src')
const TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info']
const TONE_LITERAL = /'(?:neutral|accent|success|warning|danger|info|muted)'/
// A prop or field declared as `tone?: ...` or `tones?: ...`.
const TONE_FIELD = /^\s*tones?\??:(.*)$/
const RECIPE_TONE = /\btone: \{/

// tone.ts holds the union itself and sparkline.ts its deprecated alias.
const files = [...new Glob('*.{kay,ts}').scanSync(SRC)].filter(file => file !== 'tone.ts' && file !== 'sparkline.ts').toSorted()

test('a component takes the exported Tone, not a union of its own', async () => {
  const own: string[] = []

  for (const file of files) {
    const lines = (await Bun.file(join(SRC, file)).text()).split('\n')

    for (const [at, line] of lines.entries()) {
      const field = TONE_FIELD.exec(line)

      if (field && TONE_LITERAL.test(field[1]!))
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
