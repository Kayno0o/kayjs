import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mergeSupports } from '../src/build/supports'
import { scratchDir } from './scratch'

let dir: string

beforeAll(async () => {
  dir = await scratchDir('supports-')
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

// What Bun's bundler makes of a stylesheet, minified or not.
async function bundled(css: string, minify = false): Promise<string> {
  const file = join(dir, `${Bun.hash(css + minify)}.css`)

  await Bun.write(file, css)

  const build = await Bun.build({ entrypoints: [file], minify })

  return build.outputs[0]!.text()
}

const TAILWIND = '@supports (color: color-mix(in lab, red, red))'

describe('mergeSupports', () => {
  it('keeps every override Tailwind nests in a rule for a color-mix(), through Bun, minified or not', async () => {
    const css = `:root {\n  --a: var(--x);\n  ${TAILWIND} {\n    & {\n      --a: color-mix(in srgb, var(--x) 14%, var(--y));\n    }\n  }\n  --b: var(--z);\n  ${TAILWIND} {\n    & {\n      --b: color-mix(in srgb, var(--z) 12%, transparent);\n    }\n  }\n}\n`

    expect(await bundled(css)).not.toContain('--b: color-mix')

    for (const minify of [false, true]) {
      const out = (await bundled(mergeSupports(css), minify)).replace(/\s/g, '')

      expect(out).toContain('--a:var(--x)')
      expect(out).toContain('--b:var(--z)')
      expect(out).toContain('--a:color-mix(insrgb,var(--x)14%,var(--y))')
      expect(out).toContain('--b:color-mix(insrgb,var(--z)12%,transparent)')
    }
  })

  it('keeps a rule nested in a rule holding only custom properties, followed by one with the same selector', async () => {
    const css = `:root {\n  & { --a: 2; }\n  --c: 1;\n  & { --b: 2; }\n  .p { --d: 2; }\n  .p { --e: 2; }\n}\n`

    expect(await bundled(css)).not.toContain('--a: 2')

    for (const minify of [false, true]) {
      const out = (await bundled(mergeSupports(css), minify)).replace(/\s/g, '')

      for (const name of ['--a', '--b', '--d', '--e'])
        expect(out).toContain(`${name}:2`)
    }
  })

  it('keeps a block testing the condition of the one right before it, for other selectors too', async () => {
    const out = await bundled(mergeSupports('@supports (display: grid) { .a { --x: 2; } }\n@supports (display: grid) { .b { --y: 2; } }\n'))

    expect(out).toContain('--x: 2')
    expect(out).toContain('--y: 2')
  })

  it('keeps overrides nested under a media query in a rule, and in a rule nested in a rule', async () => {
    const out = await bundled(mergeSupports(`.a {\n  @media (width > 40rem) {\n    ${TAILWIND} { --x: 2; }\n    ${TAILWIND} { --y: 2; }\n  }\n  .b {\n    ${TAILWIND} { --z: 2; }\n    color: red;\n    ${TAILWIND} { --w: 2; }\n  }\n}\n`))

    for (const name of ['--x', '--y', '--z', '--w'])
      expect(out).toContain(`${name}: 2`)
  })

  it('ends a declaration the merged block held without its semicolon', async () => {
    expect(mergeSupports(`.a { ${TAILWIND} { --x: 2 } ${TAILWIND} { --y: 2 } }`)).toBe(`.a { ${TAILWIND} { --x: 2 ; --y: 2 } }`)
  })

  it('leaves alone blocks testing other conditions, or with a rule between, and their order', () => {
    const css = `@supports (display: grid) { .a { --x: 1 } }\n@supports (display: flex) { .a { --x: 2 } }\n@supports (display: grid) { .a { --x: 3 } }\n.b { color: red }\n@supports (display: flex) { .a { --x: 4 } }\n`

    expect(mergeSupports(css)).toBe(css)
  })

  it('reads a brace or a semicolon in a string, a comment or an unquoted url() as text', () => {
    const css = `.a { content: "}{;"; background: url(data:image/svg+xml,<svg><style>a{fill:red}</style></svg>); /* } { ; */ ${TAILWIND} { --x: 2; } }\n.b { content: '\\'}' }\n`

    expect(mergeSupports(css)).toBe(css)
    expect(mergeSupports(css.replace('.b {', `${TAILWIND} { .c { --y: 2 } }\n.b {`))).toContain('--y: 2')
  })

  it('returns a stylesheet testing nothing as it is', () => {
    const css = '.a { color: red }\n@media (width > 1px) { .a { color: blue } }\n'

    expect(mergeSupports(css)).toBe(css)
  })
})
