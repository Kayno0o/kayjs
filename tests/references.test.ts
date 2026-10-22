import { sep } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { readingAs, withReferences } from '../src/build/references'

const ROOT = `${sep}app`
const FILE = `${ROOT}${sep}src${sep}app.css`
const THEME = `${sep}lib${sep}theme.css`
const REFERENCE = `@reference ${JSON.stringify(THEME)};`

describe('withReferences', () => {
  it('puts the reference right after Tailwind\'s import, on the same line', () => {
    const css = '@import \'tailwindcss\' source("..");\n@theme {\n  --x: 1;\n}\n.a { @apply p-1; }\n'

    expect(withReferences(css, FILE, ROOT, [THEME])).toBe(`@import 'tailwindcss' source(".."); ${REFERENCE} \n@theme {\n  --x: 1;\n}\n.a { @apply p-1; }\n`)
  })

  it('starts a stylesheet with no Tailwind import', () => {
    expect(withReferences('.a { @apply p-1; }', FILE, ROOT, [THEME])).toBe(`${REFERENCE} .a { @apply p-1; }`)
  })

  it('leaves alone a stylesheet with no Tailwind import reading no theme, one outside the project, in node_modules, or naming the reference', () => {
    const plain = '.a { color: red; }\n'
    const applying = '.a { @apply p-1; }'

    expect(withReferences(plain, FILE, ROOT, [THEME])).toBe(plain)
    expect(withReferences(applying, `${sep}other${sep}app.css`, ROOT, [THEME])).toBe(applying)
    expect(withReferences(applying, `${ROOT}${sep}node_modules${sep}x${sep}a.css`, ROOT, [THEME])).toBe(applying)
    expect(withReferences(`@reference "${THEME}"; ${applying}`, FILE, ROOT, [THEME])).toBe(`@reference "${THEME}"; ${applying}`)
    expect(withReferences(applying, FILE, ROOT, [])).toBe(applying)
  })

  it('gives a stylesheet importing Tailwind the reference though it applies nothing itself', () => {
    expect(withReferences('@import \'tailwindcss\';\n@import \'./parts.css\';\n', FILE, ROOT, [THEME])).toContain(REFERENCE)
  })

  it('skips an import written in a comment', () => {
    const css = '/* @import \'tailwindcss\'; */\n@import \'tailwindcss\';\n.a { @apply p-1; }'

    expect(withReferences(css, FILE, ROOT, [THEME]).indexOf(REFERENCE)).toBeGreaterThan(css.indexOf('*/'))
  })

  it('reads the functions that look a token up as needing the theme', () => {
    expect(withReferences('.a { color: --theme(--color-x); }', FILE, ROOT, [THEME])).toContain(REFERENCE)
    expect(withReferences('.a { color: --alpha(red / 50%); }', FILE, ROOT, [THEME])).toContain(REFERENCE)
  })
})

describe('readingAs', () => {
  it('gives the text only to the reads inside its scope, of its path', async () => {
    const path = import.meta.path
    const [inside, other] = await Promise.all([
      readingAs(path, 'given', async () => {
        await Bun.sleep(5)

        return [await Bun.file(path).text(), (await Bun.file(`${import.meta.dir}/scratch.ts`).text()).slice(0, 6)]
      }),
      readingAs('/nowhere/a.css', 'other', async () => (await Bun.file(path).text()).slice(0, 6)),
    ])

    expect(inside[0]).toBe('given')
    expect(inside[1]).not.toBe('given')
    expect(other).toBe('import')
    expect((await Bun.file(path).text()).slice(0, 6)).toBe('import')
  })
})
