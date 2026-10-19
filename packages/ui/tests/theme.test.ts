import { describe, expect, test } from 'bun:test'
import { compileKay } from 'kay/compiler'
import { compile } from 'tailwindcss'

const ROOT = new URL('..', import.meta.url).pathname

// These list today's families of token names, every one under `kui-` so no app's own token meets them: a class reaching for a new family needs it added here too.
const COLOR = /\b(?:bg|text|border|ring|ring-offset|fill|stroke|outline|caret|accent)-(kui-(?:text|muted|mantle|canvas|surface\d|overlay\d|subtext\d|accent(?:-hi)?|on-accent|error|success|warning|info|row-hover|fill-hover|fill-danger|chart-\d|stamp(?:-fill(?:-hover)?)?|field-border|field-focus|avatar-ring))\b/g
const SCALE = /\b(gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|text|font|tracking|rounded)-(kui-(?:section|inline|micro|2xs|heading|label|action|card|badge-[xy]|badge|field-[xy]|notice|avatar))\b/g
const DEFINED_TOKEN = /(--[\w-]+):/g
const DEFINED_CLASS = /\.([a-z][\w-]*)/g
// A `class` attribute: a quoted string, or an expression of strings, arrays and `{ name: condition }` objects.
const CLASS_STRING_ATTRIBUTE = /\bclass="([^"]*)"/g
const CLASS_EXPRESSION = /\bclass=\{((?:[^{}]|\{[^{}]*\})*)\}/g
// A class name in an expression: a quoted string, unless a comparison makes it a value, or an object key.
const CLASS_IN_EXPRESSION = /([!=]==\s*)?'([a-z][\w-]*)'|\b([a-z][\w-]*)(?=\s*:)/g
const WHITESPACE = /\s+/
const COLOUR_TOKEN = /(--color-kui-[\w-]+): ([^;]+);/g
// A colour holds a light and a dark value, or names another colour that does.
const PAIRED = /^light-dark\([^,]+, [^,]+\)$|^var\(--color-kui-[\w-]+\)$/
// A rule setting color-scheme, with its selector.
const SCHEME = /([^{}\n]*[^{}\s])\s*\{\s*color-scheme: (\w+);/g
// A quoted class name, as a script or a component's own script writes one: `classList.add('x')`, `{ 'x': on }`.
const QUOTED = /'([a-z][\w-]*)'/g
// What chartist draws itself, styled here but written by no source of the library, and Tailwind's `group`, which the app writes on what holds a stamp.
const THIRD_PARTY = /^(?:ct-|group$)/
// The tokens of a skin's offset shadows and press-down, with their value.
const PRESS_TOKEN = /(--kui-(?:shadow-raised|shadow-press|press-travel)): ([^;]+);/g

// A `kui-` class a string or template literal ends on, with more added to it; `--kui-` names an anchor or a token.
const BUILT_CLASS = /(?<![\w-])kui-[\w-]*(?:\$\{|['"`]\s*\+)/g

const HEX = /^#[\da-f]{6}$/i
const RGB_ALPHA = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/
const LIGHT_DARK = /^light-dark\(([^,]+), (.+)\)$/
const VAR = /^var\((--color-kui-[\w-]+)\)$/
// The grounds text and controls sit on, and what must read on them: text at 4.5:1, a field's border and the focus colour at 3:1 (RGAA 3.2, 3.3).
const GROUNDS = ['mantle', 'canvas', 'surface0', 'surface1', 'fill-hover']
const TEXT = ['text', 'subtext0', 'overlay1', 'accent', 'error', 'success', 'warning', 'info']
const LINES = ['field-border', 'field-focus']

// The theme namespace a scale utility reads, by its prefix.
const NAMESPACE: Record<string, string> = { text: 'text', font: 'font-weight', tracking: 'tracking', rounded: 'radius' }

for (const prefix of ['gap', 'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr'])
  NAMESPACE[prefix] = 'spacing'

const theme = await Bun.file(`${ROOT}src/theme.css`).text()
const paths = await Array.fromAsync(new Bun.Glob('src/**/*.kay').scan({ cwd: ROOT }))
const components = await Promise.all(paths.map(async path => ({ path, source: await Bun.file(`${ROOT}${path}`).text() })))
const scripts = await Promise.all((await Array.fromAsync(new Bun.Glob('src/**/*.ts').scan({ cwd: ROOT }))).map(async path => Bun.file(`${ROOT}${path}`).text()))

const tokens = new Set([...theme.matchAll(DEFINED_TOKEN)].map(([, token]) => token))
const classes = new Set([...theme.matchAll(DEFINED_CLASS)].map(([, name = '']) => name))

// Every class a component writes: the `.class` shorthand, plain `class` attributes, and the names a `class` expression holds.
function writtenClasses(path: string, source: string): string[] {
  const template = source.slice(source.lastIndexOf('\n---\n') + 1)
  const plain = [...template.matchAll(CLASS_STRING_ATTRIBUTE)].flatMap(([, value = '']) => value.split(WHITESPACE))
  const expressions = [...template.matchAll(CLASS_EXPRESSION)].flatMap(([, expression = '']) => [...expression.matchAll(CLASS_IN_EXPRESSION)].filter(([, compared]) => compared === undefined).map(([, , quoted, key]) => quoted ?? key!))

  return [...compileKay(source, path).classes, ...plain, ...expressions].filter(Boolean)
}

const colourTokens = new Map([...theme.matchAll(COLOUR_TOKEN)].map(([, token = '', value = '']) => [token, value.trim()]))

// A token's colour in one scheme, as [r, g, b] over the given ground when it is translucent.
function colour(name: string, scheme: 0 | 1, ground?: number[]): number[] {
  const value = colourTokens.get(`--color-kui-${name}`)!
  const named = VAR.exec(value)

  if (named)
    return colour(named[1]!.slice('--color-kui-'.length), scheme, ground)

  const side = LIGHT_DARK.exec(value)![scheme + 1]!.trim()

  if (HEX.test(side))
    return [1, 3, 5].map(at => Number.parseInt(side.slice(at, at + 2), 16))

  const [, r, g, b, alpha] = RGB_ALPHA.exec(side)!.map(Number)

  return [r!, g!, b!].map((channel, index) => channel * alpha! + ground![index]! * (1 - alpha!))
}

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: number[], b: number[]): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (high! + 0.05) / (low! + 0.05)
}

// Each pair under its minimum, as `fg on ground (scheme): ratio`.
function failing(names: string[], least: number): string[] {
  return ([0, 1] as const).flatMap(scheme => GROUNDS.flatMap((ground) => {
    const under = colour(ground, scheme)

    return names.map(name => [name, contrast(colour(name, scheme, under), under)] as const)
      .filter(([, ratio]) => ratio < least)
      .map(([name, ratio]) => `${name} on ${ground} (${scheme === 0 ? 'light' : 'dark'}): ${ratio.toFixed(2)}`)
  }))
}

// What a rule holds, braces and nested rules included, found by its selector starting a line; undefined when no rule has it.
function blockOf(css: string, selector: string): string | undefined {
  for (let at = css.indexOf(`${selector} {`); at !== -1; at = css.indexOf(`${selector} {`, at + 1)) {
    if (css.slice(css.lastIndexOf('\n', at) + 1, at).trim() !== '')
      continue

    let depth = 0

    for (let end = at + selector.length + 1; end < css.length; end++) {
      if (css[end] === '{')
        depth++
      else if (css[end] === '}')
        depth--

      if (depth === 0)
        return css.slice(at, end + 1)
    }
  }

  return undefined
}

// The theme as Tailwind compiles it, with a skin's own CSS after it, or before it.
async function built(skin: string, where: 'after' | 'before' = 'after'): Promise<string> {
  const tailwind = Bun.resolveSync('tailwindcss/theme.css', ROOT)
  const compiler = await compile(`@import 'tailwindcss/theme.css' layer(theme);\n${where === 'before' ? `${skin}\n${theme}` : `${theme}\n${skin}`}`, { base: ROOT, loadStylesheet: async (_, base) => ({ path: tailwind, base, content: await Bun.file(tailwind).text() }) })

  return compiler.build([])
}

describe('theme.css', () => {
  test('reads at 4.5:1 for text and 3:1 for field borders and focus, on every ground in both schemes', () => {
    expect(failing(TEXT, 4.5)).toEqual([])
    expect(failing(LINES, 3)).toEqual([])

    for (const scheme of [0, 1] as const) {
      for (const fill of ['accent', 'accent-hi', 'error', 'success', 'warning', 'info', 'subtext0'])
        expect(contrast(colour('on-accent', scheme), colour(fill, scheme))).toBeGreaterThanOrEqual(4.5)

      // A hovered accent button shows it is hovered.
      expect(contrast(colour('accent', scheme), colour('accent-hi', scheme))).toBeGreaterThanOrEqual(1.4)
    }
  })

  test('fills a solid badge with its tone, its text read from one token a skin can set', () => {
    const solid = theme.slice(theme.indexOf(':where([data-solid])'))

    expect(solid.slice(0, solid.indexOf('}'))).toMatch(/background-color: var\(--kui-badge-tone\);[^}]*var\(--kui-badge-solid-text, var\(--color-kui-on-accent\)\)/)

    for (const [tone, colour] of [['accent', 'accent'], ['success', 'success'], ['warning', 'warning'], ['danger', 'error'], ['info', 'info']])
      expect(theme, tone).toContain(`[data-tone='${tone}']) {\n      --kui-badge-tone: var(--color-kui-${colour});`)
  })

  test('draws the controls a hairline would leave under 3:1 with the field border', () => {
    for (const selector of ['.kui-carousel-dot', '.kui-rating', '.kui-toggle-track', '.kui-btn'])
      expect(blockOf(theme, selector), selector).toContain('kui-field-border')
  })

  test('defines every colour its classes paint with', () => {
    const used = new Set([...theme.matchAll(COLOR)].map(([, name]) => `--color-${name}`))

    expect([...used].filter(token => !tokens.has(token))).toEqual([])
  })

  test('defines every size, weight, tracking and spacing its classes use beyond Tailwind\'s own', () => {
    const used = new Set([...theme.matchAll(SCALE)].map(([, prefix = '', name]) => `--${NAMESPACE[prefix]}-${name}`))

    expect([...used].filter(token => !tokens.has(token))).toEqual([])
  })

  test('defines every class a component writes, so no component carries a utility an app could not restyle', () => {
    const written = new Set(components.flatMap(({ path, source }) => writtenClasses(path, source)))

    expect(written.size).toBeGreaterThan(0)
    expect([...written].filter(name => !classes.has(name))).toEqual([])
  })

  test('defines no class that nothing writes', () => {
    const written = new Set(components.flatMap(({ path, source }) => writtenClasses(path, source)))
    const quoted = new Set([...components.map(({ source }) => source), ...scripts].flatMap(source => [...source.matchAll(QUOTED)].map(([, name]) => name)))

    expect([...classes].filter(name => !written.has(name) && !quoted.has(name) && !THIRD_PARTY.test(name))).toEqual([])
  })

  // kay leaves out the rules of the classes no file writes whole, so a class put together at runtime would lose its own.
  test('writes every class whole, never putting one together at runtime', () => {
    expect([...components.map(({ source }) => source), ...scripts].flatMap(source => source.match(BUILT_CLASS) ?? [])).toEqual([])
  })

  test('gives every colour a light and a dark value, or names another colour', () => {
    const colours = [...theme.matchAll(COLOUR_TOKEN)]

    expect(colours.length).toBeGreaterThan(0)
    expect(colours.filter(([, , value = '']) => !PAIRED.test(value)).map(([, token]) => token)).toEqual([])
  })

  test('is dark unless the system asks for light, and an explicit data-theme wins over both', () => {
    const scheme = [...theme.matchAll(SCHEME)].map(([, selector = '', value]) => `${selector.trim()} ${value}`)

    expect(scheme).toEqual([':root dark', ':root light', '[data-theme=\'light\'] light', '[data-theme=\'dark\'] dark'])
    expect(theme.indexOf('@media (prefers-color-scheme: light)')).toBeLessThan(theme.indexOf('[data-theme=\'light\']'))
  })

  test('declares its tokens as defaults, so the app\'s own @theme wins wherever it sits', async () => {
    const skin = '@theme { --color-kui-accent: red; }'

    for (const where of ['after', 'before'] as const) {
      const css = await built(skin, where)

      expect(css, where).toContain('--color-kui-accent: red;')
      expect(css, where).not.toMatch(/--color-kui-accent: light-dark/)
    }
  })

  test('marks the focused menu item and the selected palette option with an accent bar, and an outline forced colours paint', () => {
    const marks = [['.kui-menu-item', '&:focus-visible'], ['.kui-command-palette-option', '&:where([aria-selected=\'true\'])']] as const

    for (const [selector, state] of marks) {
      const bar = blockOf(blockOf(theme, selector) ?? '', state)

      expect(bar, `${selector} ${state}`).toContain('box-shadow: inset 2px 0 0 var(--color-kui-accent);')
      expect(bar, `${selector} ${state}`).toContain('outline: 2px solid transparent;')
    }
  })

  test('sizes a select by its options inside a compact field, and by the row inside any other', async () => {
    const css = await built('')
    const rule = (selector: string) => css.search(new RegExp(String.raw`${selector} \{\s*width: (?:100%|auto);`))
    const full = rule(String.raw`\.kui-form-field :where\([^{]*select,\s*textarea\s*\)`)
    const compact = rule(String.raw`\.kui-form-field:where\(\[data-compact\]\) :where\(select\)`)

    expect(full).toBeGreaterThan(-1)
    expect(compact).toBeGreaterThan(full)
    expect(css.slice(compact)).toMatch(/^[^}]*width: auto;/)
  })

  test('zeroes the padding of a grouped field\'s legend, which an app\'s own `legend` styles would indent', () => {
    expect(blockOf(theme, '.kui-form-field-head')).toMatch(/@apply [^;]*\bp-0\b/)
  })

  test('draws no offset shadow nor press-down unless a skin sets their tokens alone', async () => {
    const build = async (skin: string) => [...(await built(skin)).matchAll(PRESS_TOKEN)].map(([, token, value]) => `${token} ${value}`)

    expect(await build('')).toEqual(['--kui-shadow-raised none', '--kui-shadow-press none', '--kui-press-travel 0px'])
    expect(await build('@theme { --kui-shadow-raised: 4px 4px 0 black; --kui-shadow-press: 3px 3px 0 black; --kui-press-travel: 3px; }')).toEqual(['--kui-shadow-raised 4px 4px 0 black', '--kui-shadow-press 3px 3px 0 black', '--kui-press-travel 3px'])
    expect(blockOf(theme, ':is(.kui-card, .kui-card-row, .kui-widget, .kui-toast)')).toContain('box-shadow: var(--kui-shadow-raised);')

    const press = blockOf(theme, '.kui-icon-btn:where(.kui-shell)')

    expect(press).toContain('box-shadow: var(--kui-shadow-press);')
    expect(blockOf(press ?? '', '&:active')).toContain('translate: 0 var(--kui-press-travel);')
  })

  test('rounds cards, buttons and overlays by --radius-kui-card, square unless a skin sets it', async () => {
    const css = await built('@theme { --radius-kui-card: 0.5rem; }')
    const rounded = [...css.matchAll(/([^{}]+)\{[^{}]*border-radius: var\(--radius-kui-card\)[^{}]*\}/g)].map(([, selectors]) => selectors).join(',')

    for (const name of ['kui-btn', 'kui-shell', 'kui-stat-badge', 'kui-card', 'kui-card-row', 'kui-widget', 'kui-notice', 'kui-toast', 'kui-dialog', 'kui-command-palette', 'kui-popover'])
      expect(rounded, name).toContain(`.${name}`)

    expect(css).toContain('--radius-kui-card: 0.5rem')
    expect(theme).toContain('--radius-kui-card: 0px;')
    // The hairline drawn over a shell follows its corners.
    expect(blockOf(theme, ':is(.kui-shell, .kui-btn, .kui-stat-badge)::before')).toContain('border-radius: inherit;')
  })

  test('draws the info toast in the info colour, the danger and success toasts in theirs', () => {
    const toast = blockOf(theme, '.kui-toast') ?? ''

    expect(blockOf(toast, '&:where([data-tone=\'info\'])')).toContain('--kui-toast-tone: var(--color-kui-info);')
    expect(blockOf(toast, '&:where([data-tone=\'danger\'])')).toContain('--kui-toast-tone: var(--color-kui-error);')
    expect(blockOf(toast, '&:where([data-tone=\'success\'])')).toContain('--kui-toast-tone: var(--color-kui-success);')
  })
})
