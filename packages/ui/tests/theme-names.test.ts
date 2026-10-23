import { describe, expect, test } from 'bun:test'
import { compile } from 'tailwindcss'
import { themeBlockTokens } from '../../../src/build/ui-info'
import { UI_TOKENS } from '../../../src/check/ui-tokens'

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

// The old names theme.css still defines itself, as they fold into another name or into one of Tailwind's, until the readers of each move to the new one (#2080 lane 4).
const NOT_ALIASED = new Set([
  '--color-kui-overlay1',
  '--color-kui-fill-hover',
  '--color-kui-stamp',
  '--color-kui-stamp-fill',
  '--color-kui-stamp-fill-hover',
  '--color-kui-avatar-ring',
  '--kui-chart-1',
  '--kui-chart-2',
  '--kui-chart-3',
  '--kui-chart-4',
  '--kui-chart-5',
  '--kui-chart-6',
  '--text-kui-micro',
  '--text-kui-micro--line-height',
  '--tracking-kui-section',
  '--tracking-kui-action',
  '--font-kui-mono',
  '--radius-kui-sm',
  '--radius-kui-md',
  '--kui-border-width',
  '--kui-border-card',
  '--kui-border-input',
  '--kui-border-badge',
  '--kui-border-stamp',
  '--kui-border-notice',
  '--kui-border-avatar',
  '--kui-table-height',
  '--kui-line-chart-height',
  '--kui-bar-chart-height',
  '--kui-scatter-chart-height',
  '--kui-zoom-scale',
  '--kui-badge-solid-text',
])

interface Declared { name: string, value: string, reference: boolean, inline: boolean }

function declared(css: string): Declared[] {
  return [...css.replace(COMMENT, '').matchAll(BLOCK)].flatMap(([, head = '', body = '']) =>
    [...body.matchAll(DECLARATION)].map(([, name = '', value = '']) => ({ name, value: value.trim(), reference: head.includes('reference'), inline: head.includes('inline') })))
}

const blocks = declared(theme)
const aliases = new Map(blocks.filter(entry => entry.reference).map(entry => [entry.name, entry.value]))
const defaults = new Map(blocks.filter(entry => !entry.reference).map(entry => [entry.name, entry.value]))

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

const ALL_CANDIDATES = [...aliases.keys()].filter(name => name.startsWith('--color-kui-')).flatMap(name => [`bg-${name.slice('--color-'.length)}`, `text-${name.slice('--color-'.length)}/50`, `border-${name.slice('--color-'.length)}`])

describe('the theme names', () => {
  test('keeps the new blocks free of nested braces, which the dev tool and the language server read with', () => {
    const bodies = [...theme.replace(COMMENT, '').matchAll(/@theme\b[^{;]*\{/g)]

    expect(bodies.length).toBe(3)
    expect([...theme.replace(COMMENT, '').matchAll(BLOCK)]).toHaveLength(3)
  })

  test('lists the new names for the Styles tab and completion, and the old ones kept as aliases as deprecated', () => {
    const tokens = new Map(themeBlockTokens(theme).map(token => [token.name, token]))

    for (const name of ['--color-background', '--color-foreground', '--color-accent', '--color-surface', '--color-border', '--color-muted', '--color-danger', '--color-chart-6', '--text-2xs', '--tracking-label', '--density', '--border-width', '--label-case', '--font-label', '--shadow-raised', '--press-travel'])
      expect(tokens.get(name), name).toMatchObject({ name })

    expect([...tokens.values()].filter(token => token.deprecated).map(token => token.name).toSorted()).toEqual([...aliases.keys()].toSorted())
    expect(tokens.get('--color-accent')?.deprecated).toBeUndefined()
    expect(tokens.get('--color-kui-overlay1')?.deprecated).toBeUndefined()
    expect(tokens.get('--color-kui-surface2')?.deprecated).toBe(true)
  })

  test('maps every alias onto the name the lint table gives it, and every other renamed name stays defined until its readers move', () => {
    for (const [old, value] of aliases) {
      expect(UI_TOKENS[old], old).toBeDefined()
      expect(value, old).toBe(`var(${UI_TOKENS[old]!.to})`)
    }

    for (const [old, token] of Object.entries(UI_TOKENS)) {
      if (token.to === undefined)
        continue

      if (aliases.has(old))
        expect(NOT_ALIASED.has(old), old).toBe(false)
      else
        expect(NOT_ALIASED.has(old), `${old} is neither aliased nor listed as waiting for lane 4`).toBe(true)
    }

    // The ones kept are defined by theme.css itself, or are set per instance and have no default.
    for (const old of NOT_ALIASED) {
      if (!['--kui-table-height', '--kui-line-chart-height', '--kui-bar-chart-height', '--kui-scatter-chart-height', '--kui-zoom-scale', '--kui-badge-solid-text', ...[1, 2, 3, 4, 5, 6].map(n => `--kui-chart-${n}`)].includes(old))
        expect(defaults.has(old), old).toBe(true)
    }
  })

  test('has the lint table say a declaration is renamed exactly where the new name reads the old one first', () => {
    for (const [old, token] of Object.entries(UI_TOKENS)) {
      if (token.to === undefined)
        continue

      const reads = new RegExp(`^var\\(${old}[,)]`).test(defaults.get(token.to) ?? '')

      expect(token.declares === true, `${old} declares ${token.to}`).toBe(reads)
    }
  })

  test('reads every new name through its old one first, a seed with the default as the last fallback', () => {
    for (const [name, value] of defaults) {
      const old = Object.entries(UI_TOKENS).find(([, token]) => token.declares === true && token.to === name)?.[0]

      if (old !== undefined)
        expect(value, name).toMatch(new RegExp(`^var\\(${old}[,)]`))
    }

    expect(defaults.get('--color-background')).toContain('var(--color-base,')
    expect(defaults.get('--color-foreground')).toContain('var(--color-text,')
    expect(defaults.get('--color-danger')).toContain('var(--color-error,')
  })

  test('registers --border-width as a length like the old name', () => {
    expect([...theme.matchAll(PROPERTY_AT_RULE)].map(([, name]) => name)).toEqual(expect.arrayContaining(['--border-width', '--kui-border-width']))
  })

  test('never defines a name Tailwind ships', () => {
    const shipped = new Set(declared(tailwindTheme).map(entry => entry.name))

    // The Tailwind names the old, prefixed names still fold into stay read, not redefined, until the folds land.
    const redefined = [...defaults.keys(), ...aliases.keys()].filter(name => shipped.has(name))

    expect(redefined).toEqual([])
  })

  test('still builds an old utility, which reads the new name', async () => {
    const css = await built('', ['bg-kui-surface2', 'text-kui-accent/50', 'border-kui-mantle', 'text-kui-2xs', 'tracking-kui-label', 'rounded-kui-card', 'text-kui-overlay1'])

    expect(css).toContain('background-color: var(--color-border)')
    expect(css).toMatch(/color: color-mix\(in oklab, var\(--color-accent\) 50%, transparent\)/)
    expect(css).toContain('border-color: var(--color-popover)')
    expect(css).toContain('font-size: var(--text-2xs)')
    expect(css).toContain('letter-spacing: var(--tracking-label)')
    expect(css).toContain('border-radius: var(--radius-kui-card)')
    expect(css).toContain('color: var(--color-kui-overlay1)')
  })

  test('writes no old name that an app did not set, nor forms a cycle with the new ones', async () => {
    const css = await built('.probe { color: var(--color-accent); background: var(--color-surface); border-color: var(--color-border); outline-color: var(--color-muted); fill: var(--color-chart-6); box-shadow: var(--shadow-raised); translate: 0 var(--press-travel); padding: var(--density); text-transform: var(--label-case); font-family: var(--font-label, inherit); }', ALL_CANDIDATES)
    const dependencies = rootDependencies(css)

    expect(dependencies.has('--color-accent')).toBe(true)

    for (const old of aliases.keys())
      expect(dependencies.has(old), old).toBe(false)

    expect(cycleIn(dependencies)).toBeUndefined()
  })

  test('forms no cycle when an app sets old names, new names or both', async () => {
    for (const app of [
      '@theme { --color-kui-accent: red; --color-kui-canvas: white; --color-kui-surface0: gray; --kui-density: 0.75; --kui-label-case: none; }',
      '@theme { --color-accent: red; --color-background: white; --color-surface: gray; --density: 0.75; --label-case: none; }',
      '@theme { --color-kui-accent: red; --color-accent: blue; --color-kui-muted: gray; --color-muted: black; }',
    ]) {
      const css = await built(`${app}\n.probe { color: var(--color-accent); background: var(--color-surface); border-color: var(--color-border); outline-color: var(--color-muted); fill: var(--color-chart-1); background-color: var(--color-popover); padding: var(--density); text-transform: var(--label-case); }`, ALL_CANDIDATES)

      expect(cycleIn(rootDependencies(css)), app).toBeUndefined()
    }
  })

  test('restyles from an app that sets an old name, and writes that name only because a fallback reads it', async () => {
    const css = await built('@theme { --color-kui-accent: red; --kui-label-case: none; }\n.probe { color: var(--color-accent); text-transform: var(--label-case); }')

    expect(css).toContain('--color-kui-accent: red;')
    expect(css).toContain('--color-accent: var(--color-kui-accent, light-dark(#ab433a, #ec9086));')
    expect(css).toContain('--kui-label-case: none;')
    expect(css).not.toContain('--color-kui-canvas:')
  })

  test('restyles from an app that sets a new name, which wins over the default and over the old name\'s fallback', async () => {
    const css = await built('@theme { --color-accent: red; --color-surface: gray; }\n.probe { color: var(--color-accent); background: var(--color-surface); }')

    expect(css).toContain('--color-accent: red;')
    expect(css).toContain('--color-surface: gray;')
    expect(css).not.toContain('--color-accent: var(--color-kui-accent')
  })

  test('takes the colours an app built from the template already sets, through the three permanent fallbacks', async () => {
    const css = await built('@theme { --color-base: #101010; --color-text: #eee; --color-error: #f00; }\n.probe { color: var(--color-foreground); background: var(--color-background); border-color: var(--color-danger); }')

    expect(css).toContain('--color-background: var(--color-kui-canvas, var(--color-base,')
    expect(css).toContain('--color-base: #101010;')
    expect(css).toContain('--color-text: #eee;')
    expect(css).toContain('--color-error: #f00;')
  })
})
