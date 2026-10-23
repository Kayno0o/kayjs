import { describe, expect, test } from 'bun:test'
import { compile } from 'tailwindcss'
import { themeBlockTokens } from '../../../src/build/ui-info'

const ROOT = new URL('..', import.meta.url).pathname
const TAILWIND = Bun.resolveSync('tailwindcss/theme.css', ROOT)

const theme = await Bun.file(`${ROOT}src/theme.css`).text()
const tailwindTheme = await Bun.file(TAILWIND).text()

const BLOCK = /@theme([^{;]*)\{([^{}]*)\}/g
const DECLARATION = /^\s*(--[\w-]+)\s*:([^;]+);/gm
const COMMENT = /\/\*[\s\S]*?\*\//g
const VAR_NAME = /var\((--[\w-]+)/g
const ROOT_DECLARATION = /^\s{4}(--[\w-]+): (.+);$/gm
const PROPERTY_AT_RULE = /@property\s+(--[\w-]+)/g

interface Declared { name: string, value: string }

function declared(css: string): Declared[] {
  return [...css.replace(COMMENT, '').matchAll(BLOCK)].flatMap(([, , body = '']) => [...body.matchAll(DECLARATION)].map(([, name = '', value = '']) => ({ name, value: value.trim() })))
}

const blocks = declared(theme)
const defaults = new Map(blocks.map(entry => [entry.name, entry.value]))

async function built(extra: string, candidates: string[] = []): Promise<string> {
  const compiler = await compile(`@import 'tailwindcss/theme.css' layer(theme);\n${theme}\n@tailwind utilities;\n${extra}`, { base: ROOT, loadStylesheet: async (_, base) => ({ path: TAILWIND, base, content: tailwindTheme }) })

  return compiler.build(candidates)
}

// The custom properties written to the page and the names each reads, fallbacks included.
function rootDependencies(css: string): Map<string, string[]> {
  const found = new Map<string, string[]>()

  for (const [, name = '', value = ''] of css.matchAll(ROOT_DECLARATION))
    found.set(name, [...value.matchAll(VAR_NAME)].map(([, read = '']) => read))

  return found
}

function cycleIn(graph: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 1 | 2>()
  const path: string[] = []

  function visit(name: string): string[] | undefined {
    if (state.get(name) === 2)
      return undefined

    if (state.get(name) === 1)
      return [...path.slice(path.indexOf(name)), name]

    state.set(name, 1)
    path.push(name)

    for (const read of graph.get(name) ?? []) {
      const found = visit(read)

      if (found)
        return found
    }

    path.pop()
    state.set(name, 2)

    return undefined
  }

  for (const name of graph.keys()) {
    const found = visit(name)

    if (found)
      return found
  }

  return undefined
}

describe('the theme names', () => {
  test('keeps the new blocks free of nested braces, which the dev tool and the language server read with', () => {
    const opened = [...theme.replace(COMMENT, '').matchAll(/@theme\b[^{;]*\{/g)]
    const closed = [...theme.replace(COMMENT, '').matchAll(BLOCK)]

    expect(opened.length).toBeGreaterThan(0)
    expect(closed).toHaveLength(opened.length)
  })

  test('lists the names for the Styles tab and completion', () => {
    const tokens = new Map(themeBlockTokens(theme).map(token => [token.name, token]))

    for (const name of ['--color-background', '--color-foreground', '--color-accent', '--color-surface', '--color-border', '--color-muted', '--color-danger', '--color-chart-6', '--text-2xs', '--tracking-label', '--density', '--border-width', '--label-case', '--shadow-raised', '--press-travel'])
      expect(tokens.get(name), name).toMatchObject({ name })
  })

  test('registers --border-width as a length', () => {
    expect([...theme.matchAll(PROPERTY_AT_RULE)].map(([, name]) => name)).toEqual(expect.arrayContaining(['--border-width']))
  })

  test('never defines a name Tailwind ships', () => {
    const shipped = new Map([...tailwindTheme.replace(COMMENT, '').matchAll(/^ {2}(--[\w-]+): ?([^;]+);/gm)].map(([, name = '', value = '']) => [name, value.trim()]))

    // The four steps the theme folds into keep Tailwind's own value, so an app that sets nothing renders them as Tailwind does.
    const redefined = [...defaults.keys()].filter(name => shipped.has(name))

    expect(redefined.toSorted()).toEqual(['--font-mono', '--radius-lg', '--radius-md', '--radius-sm'])

    for (const name of redefined) {
      const tailwind = shipped.get(name)!.replace(/\s+/g, ' ')

      expect(defaults.get(name)!.replace(/\s+/g, ' '), name).toBe(tailwind)
    }
  })

  test('forms no cycle among the names it writes to the page', async () => {
    const css = await built('.probe { color: var(--color-accent); background: var(--color-surface); border-color: var(--color-border); outline-color: var(--color-muted); fill: var(--color-chart-6); box-shadow: var(--shadow-raised); translate: 0 var(--press-travel); padding: var(--density); text-transform: var(--label-case); font-family: var(--font-label, inherit); }')
    const dependencies = rootDependencies(css)

    expect(dependencies.has('--color-accent')).toBe(true)
    expect(cycleIn(dependencies)).toBeUndefined()
  })

  test('forms no cycle when an app sets the names', async () => {
    const app = '@theme { --color-accent: red; --color-background: white; --color-surface: gray; --density: 0.75; --label-case: none; }'
    const css = await built(`${app}\n.probe { color: var(--color-accent); background: var(--color-surface); border-color: var(--color-border); outline-color: var(--color-muted); fill: var(--color-chart-1); background-color: var(--color-popover); padding: var(--density); text-transform: var(--label-case); }`)

    expect(rootDependencies(css).has('--color-accent'), app).toBe(true)
    expect(cycleIn(rootDependencies(css)), app).toBeUndefined()
  })

  test('restyles from an app that sets a name, which wins over the default', async () => {
    const css = await built('@theme { --color-accent: red; --color-surface: gray; }\n.probe { color: var(--color-accent); background: var(--color-surface); }')

    expect(css).toContain('--color-accent: red;')
    expect(css).toContain('--color-surface: gray;')
  })

  test('takes the colours an app built from the template already sets, through the three fallbacks', async () => {
    const css = await built('@theme { --color-base: #101010; --color-text: #eee; --color-error: #f00; }\n.probe { color: var(--color-foreground); background: var(--color-background); border-color: var(--color-danger); }')

    expect(css).toContain('--color-background: var(--color-base,')
    expect(css).toContain('--color-base: #101010;')
    expect(css).toContain('--color-text: #eee;')
    expect(css).toContain('--color-error: #f00;')
  })
})
