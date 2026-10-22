import type { BunPlugin } from 'bun'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mergingSupports } from '../src/build/supports'
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

// The merge as the stylesheet build runs it on a stylesheet no plugin loads, the text as it is when nothing merges.
async function mergeSupports(css: string): Promise<string> {
  const file = join(dir, `merge-${Bun.hash(css)}.css`)
  let load: ((args: { path: string }) => unknown) | undefined

  await Bun.write(file, css)
  await mergingSupports([]).at(-1)!.setup({ onLoad: (_: unknown, callback: typeof load) => {
    load = callback
  } } as never)

  const result = await load!({ path: file }) as { contents: string } | undefined

  return result?.contents ?? css
}

describe('mergeSupports', () => {
  it('keeps every override Tailwind nests in a rule for a color-mix(), through Bun, minified or not', async () => {
    const css = `:root {\n  --a: var(--x);\n  ${TAILWIND} {\n    & {\n      --a: color-mix(in srgb, var(--x) 14%, var(--y));\n    }\n  }\n  --b: var(--z);\n  ${TAILWIND} {\n    & {\n      --b: color-mix(in srgb, var(--z) 12%, transparent);\n    }\n  }\n}\n`

    // Bun 1.4.4 still drops it: once this fails, Bun fixed it and the merge can go.
    expect(await bundled(css)).not.toContain('--b: color-mix')

    for (const minify of [false, true]) {
      const out = (await bundled(await mergeSupports(css), minify)).replace(/\s/g, '')

      expect(out).toContain('--a:var(--x)')
      expect(out).toContain('--b:var(--z)')
      expect(out).toContain('--a:color-mix(insrgb,var(--x)14%,var(--y))')
      expect(out).toContain('--b:color-mix(insrgb,var(--z)12%,transparent)')
    }
  })

  it('keeps a rule nested in a rule holding only custom properties, followed by one with the same selector', async () => {
    const css = `:root {\n  & { --a: 2; }\n  --c: 1;\n  & { --b: 2; }\n  .p { --d: 2; }\n  .p { --e: 2; }\n}\n`

    // Bun 1.4.4 still drops it: once this fails, Bun fixed it and the merge can go.
    expect(await bundled(css)).not.toContain('--a: 2')

    for (const minify of [false, true]) {
      const out = (await bundled(await mergeSupports(css), minify)).replace(/\s/g, '')

      for (const name of ['--a', '--b', '--d', '--e'])
        expect(out).toContain(`${name}:2`)
    }
  })

  it('keeps a block testing the condition of the one right before it, for other selectors too', async () => {
    const out = await bundled(await mergeSupports('@supports (display: grid) { .a { --x: 2; } }\n@supports (display: grid) { .b { --y: 2; } }\n'))

    expect(out).toContain('--x: 2')
    expect(out).toContain('--y: 2')
  })

  it('keeps overrides nested under a media query in a rule, and in a rule nested in a rule', async () => {
    const out = await bundled(await mergeSupports(`.a {\n  @media (width > 40rem) {\n    ${TAILWIND} { --x: 2; }\n    ${TAILWIND} { --y: 2; }\n  }\n  .b {\n    ${TAILWIND} { --z: 2; }\n    color: red;\n    ${TAILWIND} { --w: 2; }\n  }\n}\n`))

    for (const name of ['--x', '--y', '--z', '--w'])
      expect(out).toContain(`${name}: 2`)
  })

  it('ends a declaration the merged block held without its semicolon', async () => {
    expect(await mergeSupports(`.a { ${TAILWIND} { --x: 2 } ${TAILWIND} { --y: 2 } }`)).toBe(`.a { ${TAILWIND} { --x: 2 ; --y: 2 } }`)
  })

  it('leaves alone blocks testing other conditions, or with a rule between, and their order', async () => {
    const css = `@supports (display: grid) { .a { --x: 1 } }\n@supports (display: flex) { .a { --x: 2 } }\n@supports (display: grid) { .a { --x: 3 } }\n.b { color: red }\n@supports (display: flex) { .a { --x: 4 } }\n`

    expect(await mergeSupports(css)).toBe(css)
  })

  it('reads a brace or a semicolon in a string, a comment or an unquoted url() as text', async () => {
    const css = `.a { content: "}{;"; background: url(data:image/svg+xml,<svg><style>a{fill:red}</style></svg>); /* } { ; */ ${TAILWIND} { --x: 2; } }\n.b { content: '\\'}' }\n`

    expect(await mergeSupports(css)).toBe(css)
    expect(await mergeSupports(css.replace('.b {', `${TAILWIND} { .c { --y: 2 } }\n.b {`))).toContain('--y: 2')
  })

  it('keeps what follows a `}` closing nothing, for Bun to report it', async () => {
    const css = `.a { color: red }\n}\n.b { color: blue }\n${TAILWIND} { .c { --x: 2 } }\n${TAILWIND} { .d { --y: 2 } }\n`

    expect(await mergeSupports(css)).toBe(`.a { color: red }\n}\n.b { color: blue }\n${TAILWIND} { .c { --x: 2 }  .d { --y: 2 } }\n`)
  })

  it('leaves alone custom properties whose value is a block, and the case of a condition', async () => {
    const css = `.a { --x: { a: b }; --x: { c: d } }\n@supports (--Foo: x) { .a { --y: 1 } }\n@supports (--foo: x) { .a { --y: 2 } }\n`

    expect(await mergeSupports(css)).toBe(css)
  })

  it('merges what a plugin loads as CSS, and the stylesheets no plugin loads', async () => {
    const twice = (a: string, b: string) => `${TAILWIND} { .${a} { --x: 2 } }\n${TAILWIND} { .${b} { --y: 2 } }\n`
    const file = join(dir, 'loaded.css')

    await Bun.write(file, '')
    await Bun.write(join(dir, 'plain.css'), twice('a', 'b'))

    for (const loader of ['css', undefined] as const) {
      const plugin: BunPlugin = { name: 'loads', setup: (build) => {
        build.onLoad({ filter: /loaded\.css$/ }, () => ({ contents: `@import './plain.css';\n${twice('c', 'd')}`, ...loader && { loader } }))
      } }
      const build = await Bun.build({ entrypoints: [file], plugins: mergingSupports([plugin]) })
      const out = await build.outputs[0]!.text()

      for (const name of ['--x', '--y'])
        expect(out.split(`${name}: 2`)).toHaveLength(3)
    }
  })

  it('returns a stylesheet testing nothing as it is', async () => {
    const css = '.a { color: red }\n@media (width > 1px) { .a { color: blue } }\n'

    expect(await mergeSupports(css)).toBe(css)
  })
})
