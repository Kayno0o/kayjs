import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { styleSignature } from '../src/build/styles'
import { compileKay } from '../src/compiler'
import { formatKay } from '../src/compiler/format'
import { parseKay } from '../src/compiler/parser'
import { rebaseUrls, scopeCss } from '../src/compiler/scoped-style'
import { fixtureCopy } from './scratch'

const ATTR = 'data-k-x'
const CARD = '--- style\n.card { color: red }\n.card:hover > p, :global(body) .title::before { margin: 0 }\n@media (min-width: 40em) { .card { color: blue } }\n---\n.card\n  p.title hi\n  Child\n'

let root = ''

beforeAll(async () => {
  root = resolve(await fixtureCopy('page-styles'))
  await Bun.write(join(root, 'src/routes/scoped.kay'), `---\nimport Card from '../card.kay'\n---\nh1 Scoped\nCard\n`)
  await Bun.write(join(root, 'src/card.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64'))
  await Bun.write(join(root, 'src/card.kay'), '--- style\n.card { background: url(./card.png); color: rebeccapurple }\n:global(.outside) .card p { margin: 3px }\n---\n.card\n  p inside\n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('scopeCss', () => {
  it('leaves a custom property whose value holds braces as a value', () => {
    expect(scopeCss('.a { --x: { a: b }; color: red }', ATTR)).toBe(`.a[${ATTR}] { --x: { a: b }; color: red }`)
  })

  it('ends the last compound of every selector on the attribute', () => {
    expect(scopeCss('.a .b > i, em { color: red }', ATTR)).toBe(`.a .b > i[${ATTR}], em[${ATTR}] { color: red }`)
  })

  it('puts it before a pseudo-element and after a pseudo-class', () => {
    expect(scopeCss('p::before { content: "," } a:hover { x: y }', ATTR)).toBe(`p[${ATTR}]::before { content: "," } a:hover[${ATTR}] { x: y }`)
  })

  it('unwraps :global and scopes the last compound that is not global', () => {
    expect(scopeCss(':global(body) .a, .b :global(.c), :global(.d) { x: y }', ATTR)).toBe(`body .a[${ATTR}], .b[${ATTR}] .c, .d { x: y }`)
  })

  it('scopes the bodies of media, supports, layer and container, and leaves keyframes and font-face', () => {
    const css = '@media (min-width: 1px) { .a { x: y } } @keyframes spin { from { x: y } } @font-face { font-family: f } @import "x.css"; @layer base { .b { x: y } }'

    expect(scopeCss(css, ATTR)).toBe(`@media (min-width: 1px) { .a[${ATTR}] { x: y } } @keyframes spin { from { x: y } } @font-face { font-family: f } @import "x.css"; @layer base { .b[${ATTR}] { x: y } }`)
  })

  it('reads past strings, comments and brackets that hold selector characters', () => {
    expect(scopeCss('/* a, b { */ a[href="x,{y}"]:not(.b, .c) { content: "}" } i { x: y }', ATTR)).toBe(`/* a, b { */ a[href="x,{y}"]:not(.b, .c)[${ATTR}] { content: "}" } i[${ATTR}] { x: y }`)
  })
})

describe('scopeCss edge cases', () => {
  it('ignores comments inside a selector', () => {
    expect(scopeCss('.a /* c, d */ { x: y }', ATTR)).toBe(`.a[${ATTR}]  { x: y }`)
  })

  it('finds a pseudo-element outside brackets and strings only', () => {
    expect(scopeCss('a[href="::"]:not(:before) { x: y }', ATTR)).toBe(`a[href="::"]:not(:before)[${ATTR}] { x: y }`)
  })

  it('leaves a global element with its pseudo-classes and pseudo-elements unscoped', () => {
    expect(scopeCss(':global(.a)::before, :global(.b):hover { x: y }', ATTR)).toBe('.a::before, .b:hover { x: y }')
  })

  it('scopes the bodies of scope and starting-style', () => {
    expect(scopeCss('@starting-style { .a { x: y } }', ATTR)).toBe(`@starting-style { .a[${ATTR}] { x: y } }`)
  })
})

describe('rebaseUrls', () => {
  it('points relative references at the files they named from another folder', () => {
    expect(rebaseUrls('a { background: url(./a.png) } b { background: url("../b.png") } @import "./c.css"; i { background: url(/p.png) url(data:x) url(https://x/y) } @import "tailwindcss";', '/app/src', '/app/.kay/cache/scoped')).toBe('a { background: url(../../../src/a.png) } b { background: url("../../../b.png") } @import "../../../src/c.css"; i { background: url(/p.png) url(data:x) url(https://x/y) } @import "tailwindcss";')
  })
})

describe('the style fence', () => {
  it('is parsed as CSS, whose slashes and quotes close nothing', () => {
    const file = parseKay('--- style\na { background: url(/x/y.png); content: "\'" } /* it\'s */\n---\np hi\n')

    expect(file.style).toBeDefined()
    expect(file.diagnostics).toEqual([])
    expect(file.template).toHaveLength(1)
  })

  it('marks every element the template writes, and no component', () => {
    const html = compileKay(CARD, join(root, 'src/card-test.kay'), { root, output: 'html' }).tsx
    const attribute = (/data-k-[a-z0-9]+/).exec(html)![0]

    expect(html.split(attribute).length - 1).toBe(2)
    expect(html).not.toContain('<Child')
  })

  it('marks the elements of the island output alike', () => {
    const source = '--- style\n.a { x: y }\n--- script\nconst n = signal(0)\n---\nbutton.a(onclick={() => n++}) {n}\n'
    const server = compileKay(source, join(root, 'src/a.kay'), { root, output: 'html', hydratable: true }).tsx
    const dom = compileKay(source, join(root, 'src/a.kay'), { root, output: 'dom' }).tsx
    const attribute = (/data-k-[a-z0-9]+/).exec(server)![0]

    expect(dom).toContain(attribute)
    expect(compileKay(source, join(root, 'src/b.kay'), { root, output: 'dom' }).tsx).not.toContain(attribute)
  })

  it('is kept by the formatter', () => {
    const source = '--- style\n.a { color: red }\n---\np.a hi\n'

    expect(formatKay(source).code).toBe(source)
  })

  it('is kept by the formatter beside a script fence', () => {
    const source = '--- style\n.a { color: red }\n--- script\nconst n = 1\n---\np.a {n}\n'

    expect(formatKay(source).code).toBe(source)
  })

  it('changes the stylesheet signature of the file', async () => {
    expect(await styleSignature('/x/a.kay', '--- style\na { x: y }\n---\np hi\n')).not.toBe(await styleSignature('/x/a.kay', '--- style\na { x: z }\n---\np hi\n'))
  })

  it('reaches the page stylesheet scoped, as an imported one does', async () => {
    const client = await buildClient(root, { plugins: [tailwind] })
    const files = (await readdir(client.dir)).filter(name => name.endsWith('.css'))
    const css = (await Promise.all(files.map(async name => Bun.file(join(client.dir, name)).text()))).join('\n')

    expect(css).toMatch(/\.card\[data-k-[a-z0-9]+\]/)
    expect(css).toMatch(/\.outside \.card p\[data-k-[a-z0-9]+\]/)
    expect(css).not.toContain(':global')
    expect(css).not.toContain('url(./card.png)')
  }, 120_000)
})

describe('scopeCss nesting', () => {
  it('scopes a rule nested inside another, with its own at-rules', () => {
    expect(scopeCss('.card { color: red; .title { x: y } &:hover { x: y } > p { x: y } @media (min-width: 1px) { .t { x: y } } }', ATTR)).toBe(`.card[${ATTR}] { color: red; .title[${ATTR}] { x: y } &:hover[${ATTR}] { x: y } > p[${ATTR}] { x: y } @media (min-width: 1px) { .t[${ATTR}] { x: y } } }`)
  })

  it('leaves a nested :global alone and a rule with declarations only as written', () => {
    expect(scopeCss('.card { :global(.x) { y: z } } .b { content: "{"; color: red }', ATTR)).toBe(`.card[${ATTR}] { .x { y: z } } .b[${ATTR}] { content: "{"; color: red }`)
  })
})

describe('the style fence with Tailwind', () => {
  it('applies utilities with @apply, scoped like any rule', async () => {
    const dir = resolve(await fixtureCopy('page-styles'))

    try {
      await Bun.write(join(dir, 'src/routes/applied.kay'), `---\nimport Applied from '../applied.kay'\n---\nApplied\n`)
      await Bun.write(join(dir, 'src/applied.kay'), '--- style\n.pill { @apply rounded-full px-4 }\n---\np.pill hi\n')

      const client = await buildClient(dir, { plugins: [tailwind] })
      const css = (await Promise.all((await readdir(client.dir)).filter(name => name.endsWith('.css')).map(async name => Bun.file(join(client.dir, name)).text()))).join('\n')
      const rule = (/\.pill\[data-k-[a-z0-9]+\]\s*\{([^}]*)\}/).exec(css)?.[1] ?? ''

      expect(rule).toContain('border-radius')
      expect(rule).toContain('padding-inline')
      expect(css).not.toContain('@apply')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('the scoped stylesheets of the cache', () => {
  it('drops the one of a component a full build no longer has', async () => {
    const dir = resolve(await fixtureCopy('page-styles'))
    const build = async () => {
      const child = Bun.spawn([process.execPath, resolve('src/cli.ts'), 'build', dir, '--static', '--no-check', '--outdir', join(dir, 'out')], { stdout: 'pipe', stderr: 'pipe' })

      expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    }

    try {
      await Bun.write(join(dir, 'kay.config.ts'), 'import tailwind from \'bun-plugin-tailwind\'\n\nexport default { plugins: [tailwind] }\n')
      await Bun.write(join(dir, 'src/routes/gone.kay'), '--- style\n.gone { color: red }\n---\np.gone bye\n')
      await build()

      const scoped = join(dir, '.kay/cache/scoped')
      const before = await readdir(scoped)

      expect(before.length).toBeGreaterThan(0)
      await rm(join(dir, 'src/routes/gone.kay'))
      await Bun.write(join(dir, 'src/routes/other.kay'), '--- style\n.other { color: blue }\n---\np.other hi\n')
      await build()

      const after = await readdir(scoped)

      expect(after.length).toBeGreaterThan(0)
      expect(after.some(name => before.includes(name))).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
