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
const PAIRED = /^light-dark\(|^var\(--color-kui-[\w-]+\)$|^color-mix\(in (?:oklab|srgb), /
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
const VAR = /^var\((--color-kui-[\w-]+)\)$/
const MIX_ARGUMENT = /^(\S.*?)(?: ([\d.]+)%)?$/
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

// The seeds a skin sets alone; every other colour derives from them.
const SEEDS = ['canvas', 'text', 'accent', 'success', 'warning', 'info', 'error', 'field-border']

type Tokens = Map<string, string>

const colourTokens: Tokens = new Map([...theme.matchAll(COLOUR_TOKEN)].map(([, token = '', value = '']) => [token, value.trim()]))

// The theme's colours under a skin's own declarations, `--color-kui-name: value;`.
function withSkin(skin: string): Tokens {
  return new Map([...colourTokens, ...[...skin.matchAll(COLOUR_TOKEN)].map(([, token = '', value = '']) => [token, value.trim()] as const)])
}

// The arguments of a function call, split at the commas outside any parenthesis.
function splitArguments(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let at = 0; at < text.length; at++) {
    if (text[at] === '(') {
      depth++
    }
    else if (text[at] === ')') {
      depth--
    }
    else if (text[at] === ',' && depth === 0) {
      parts.push(text.slice(start, at).trim())
      start = at + 1
    }
  }

  return [...parts, text.slice(start).trim()]
}

const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
const gamma = (channel: number) => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
const OKLAB_FROM_LMS = [[0.2104542553, 0.793617785, -0.0040720468], [1.9779984951, -2.428592205, 0.4505937099], [0.0259040371, 0.7827717662, -0.808675766]]

function toOklab([r, g, b]: number[]): number[] {
  const [lr, lg, lb] = [r!, g!, b!].map(channel => linear(channel / 255)) as [number, number, number]
  const lms = [0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb, 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb, 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb].map(Math.cbrt)

  return OKLAB_FROM_LMS.map(row => row.reduce((sum, weight, index) => sum + weight * lms[index]!, 0))
}

function fromOklab([lightness, a, b]: number[]): number[] {
  const [l, m, s] = [lightness! + 0.3963377774 * a! + 0.2158037573 * b!, lightness! - 0.1055613458 * a! - 0.0638541728 * b!, lightness! - 0.0894841775 * a! - 1.291485548 * b!].map(value => value ** 3) as [number, number, number]

  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(channel => Math.min(255, Math.max(0, gamma(channel) * 255)))
}

interface Colour {
  rgb: number[]
  alpha: number
}

// The shares of a mix as percentages, the one left out taking what the other leaves, an even split when both are.
function mixWeights(first: string | undefined, second: string | undefined): number[] {
  if (first === undefined && second === undefined)
    return [50, 50]

  const one = first === undefined ? 100 - Number(second) : Number(first)

  return [one, second === undefined ? 100 - one : Number(second)]
}

// A colour expression as one scheme draws it: what the theme writes, a seed set to a single colour included.
function evaluate(expression: string, scheme: 0 | 1, tokens: Tokens): Colour {
  const text = expression.trim()
  const named = VAR.exec(text)

  if (named)
    return evaluate(tokens.get(named[1]!)!, scheme, tokens)

  if (text.startsWith('light-dark('))
    return evaluate(splitArguments(text.slice('light-dark('.length, -1))[scheme]!, scheme, tokens)

  if (text.startsWith('color-mix(')) {
    const [space, ...parts] = splitArguments(text.slice('color-mix('.length, -1))
    const [first, second] = parts.map(part => MIX_ARGUMENT.exec(part)!)
    const weights = mixWeights(first![2], second![2])
    const [one, two] = [evaluate(first![1]!, scheme, tokens), evaluate(second![1]!, scheme, tokens)]
    const alpha = (one.alpha * weights[0]! + two.alpha * weights[1]!) / 100
    // Interpolated premultiplied by alpha, as the specification has it.
    const share = [one.alpha * weights[0]!, two.alpha * weights[1]!].map(weight => weight / (alpha * 100))
    const channels = space === 'in oklab' ? [one, two].map(colour => toOklab(colour.rgb)) : [one.rgb, two.rgb]
    const mixed = channels[0]!.map((value, index) => value * share[0]! + channels[1]![index]! * share[1]!)

    return { rgb: space === 'in oklab' ? fromOklab(mixed) : mixed, alpha }
  }

  if (text === 'black')
    return { rgb: [0, 0, 0], alpha: 1 }

  if (text === 'white')
    return { rgb: [255, 255, 255], alpha: 1 }

  if (text === 'transparent')
    return { rgb: [0, 0, 0], alpha: 0 }

  if (HEX.test(text))
    return { rgb: [1, 3, 5].map(at => Number.parseInt(text.slice(at, at + 2), 16)), alpha: 1 }

  const [, r, g, b, alpha] = RGB_ALPHA.exec(text)!.map(Number)

  return { rgb: [r!, g!, b!], alpha: alpha! }
}

// A token's colour in one scheme, as [r, g, b] over the given ground when it is translucent.
function colour(name: string, scheme: 0 | 1, ground?: number[], tokens: Tokens = colourTokens): number[] {
  const { rgb, alpha } = evaluate(`var(--color-kui-${name})`, scheme, tokens)

  return rgb.map((channel, index) => alpha === 1 ? channel : channel * alpha + ground![index]! * (1 - alpha))
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
function failing(names: string[], least: number, tokens: Tokens = colourTokens, schemes: readonly (0 | 1)[] = [0, 1]): string[] {
  return schemes.flatMap(scheme => GROUNDS.flatMap((ground) => {
    const under = colour(ground, scheme, undefined, tokens)

    return names.map(name => [name, contrast(colour(name, scheme, under, tokens), under)] as const)
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

  test('derives every colour but the seeds from them, so a skin sets eight colours and not twenty', () => {
    const own = [...colourTokens].filter(([, value]) => !value.includes('var(--color-kui-') && !value.startsWith('color-mix('))

    expect(own.map(([token]) => token.slice('--color-kui-'.length)).toSorted()).toEqual([...SEEDS, 'chart-5', 'chart-6'].toSorted())
  })

  test('keeps the look the literals gave, each derived colour within a few steps of its old value in both schemes', () => {
    // The palette before it derived: [light, dark], composited over the canvas where translucent; the accent's hover is the accent shaded.
    const WAS: Record<string, [number[], number[]]> = {
      'mantle': [[0xEF, 0xEC, 0xE6], [0x0D, 0x0D, 0x0D]],
      'surface0': [[0xF4, 0xF1, 0xEC], [0x16, 0x16, 0x16]],
      'surface1': [[0xEC, 0xE8, 0xE1], [0x1B, 0x1B, 0x1B]],
      'surface2': [[0xE1, 0xDF, 0xDB], [0x2B, 0x2B, 0x2B]],
      'overlay0': [[0xC5, 0xC3, 0xBF], [0x45, 0x45, 0x45]],
      'overlay1': [[0x6D, 0x68, 0x5F], [0x8A, 0x85, 0x7D]],
      'subtext0': [[0x62, 0x5D, 0x55], [0x9C, 0x97, 0x8E]],
      'accent-hi': [[0x7D, 0x2A, 0x22], [0xF8, 0xC0, 0xB8]],
      'on-accent': [[0xFF, 0xFF, 0xFF], [0x1A, 0x0D, 0x0B]],
      'fill-hover': [[0xEC, 0xE8, 0xE1], [0x1C, 0x1C, 0x1C]],
      'fill-danger': [[0xF8, 0xE4, 0xE1], [0x24, 0x16, 0x15]],
      'row-hover': [[0xF0, 0xEE, 0xEA], [0x1D, 0x1D, 0x1D]],
    }

    for (const [name, was] of Object.entries(WAS)) {
      for (const scheme of [0, 1] as const) {
        const now = colour(name, scheme, colour('canvas', scheme))
        const furthest = Math.max(...now.map((channel, index) => Math.abs(channel - was[scheme][index]!)))

        expect(furthest, `${name} ${scheme === 0 ? 'light' : 'dark'}`).toBeLessThanOrEqual(name === 'on-accent' ? 11 : 10)
      }
    }
  })

  test('reads at the same contrast from a skin that sets the seeds alone, in both schemes', () => {
    const skins = [
      '--color-kui-canvas: light-dark(#fffdf7, #1a1814); --color-kui-text: light-dark(#26211a, #ece6d8); --color-kui-accent: light-dark(#9a3412, #fb923c); --color-kui-success: light-dark(#3f6212, #a3e635); --color-kui-warning: light-dark(#854d0e, #facc15); --color-kui-info: light-dark(#1d4ed8, #93c5fd); --color-kui-error: light-dark(#b91c1c, #fca5a5); --color-kui-field-border: light-dark(#85776a, #8a7e70);',
      '--color-kui-canvas: light-dark(#f3f6fa, #0b1220); --color-kui-text: light-dark(#0f1b2d, #dbe4f0); --color-kui-accent: light-dark(#1d4ed8, #7aa2f7); --color-kui-success: light-dark(#166534, #86efac); --color-kui-warning: light-dark(#92400e, #fcd34d); --color-kui-info: light-dark(#0b5f78, #67e8f9); --color-kui-error: light-dark(#b91c1c, #fda4af); --color-kui-field-border: light-dark(#6b7d94, #5f7390);',
    ]

    for (const skin of skins) {
      const tokens = withSkin(skin)

      expect(failing(TEXT, 4.5, tokens), skin).toEqual([])
      expect(failing(LINES, 3, tokens), skin).toEqual([])

      for (const scheme of [0, 1] as const) {
        for (const fill of ['accent', 'accent-hi'])
          expect(contrast(colour('on-accent', scheme, undefined, tokens), colour(fill, scheme, undefined, tokens)), `${skin} ${fill}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('reads from a skin of one scheme that writes its seeds once and pins color-scheme to it', () => {
    const tokens = withSkin('--color-kui-canvas: #ffffff; --color-kui-text: #111111; --color-kui-accent: #a21caf; --color-kui-success: #166534; --color-kui-warning: #92400e; --color-kui-info: #1d4ed8; --color-kui-error: #b91c1c; --color-kui-field-border: #767676;')

    expect(failing(TEXT, 4.5, tokens, [0])).toEqual([])
    expect(failing(LINES, 3, tokens, [0])).toEqual([])
    expect(contrast(colour('on-accent', 0, undefined, tokens), colour('accent-hi', 0, undefined, tokens))).toBeGreaterThanOrEqual(4.5)
  })

  test('derives from whichever seeds a skin sets and keeps the default for the others', () => {
    const tokens = withSkin('--color-kui-canvas: light-dark(#ffffff, #000000);')

    expect(colour('surface0', 0, undefined, tokens)).not.toEqual(colour('surface0', 0))
    expect(colour('surface0', 1, undefined, tokens).every(Number.isFinite)).toBe(true)
    // Black is darker than the default canvas, so the dark surface sits between the two.
    expect(colour('surface0', 1, undefined, tokens)[0]!).toBeLessThan(colour('surface0', 1)[0]!)
    expect(colour('accent', 0, undefined, tokens)).toEqual(colour('accent', 0))
  })

  test('lets a token the skin sets beat what derives it, in the compiled CSS wherever the skin sits', async () => {
    for (const where of ['after', 'before'] as const) {
      const css = await built('@theme { --color-kui-canvas: #fff; --color-kui-surface0: red; }', where)

      expect(css, where).toContain('--color-kui-surface0: red;')
      expect(css, where).toContain('--color-kui-canvas: #fff;')
      expect(css, where).not.toMatch(/--color-kui-surface0: color-mix/)
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

  test('sizes the keyline of every framed box by --kui-border-width, a length the old --kui-border-card still sets', () => {
    for (const selector of ['.kui-card', '.kui-card-head', '.kui-card-row', '.kui-widget', '.kui-toast', '.kui-dialog', '.kui-command-palette', '.kui-popover', '.kui-side-panel', '.kui-tooltip', '.kui-table-wrap', '.kui-collapsible-section', '.kui-save-bar', '.kui-segmented', '.kui-file-drop', '.kui-pagination-step', ':where(.kui-site-nav-list:popover-open)', '.kui-line-chart-tooltip'])
      expect(blockOf(theme, selector), selector).toMatch(/border(?:-[bl])?-\(length:--kui-border-width\)/)

    expect(theme.match(/var\(--kui-border-card\)/g)).toHaveLength(1)
    expect(theme).toContain('--kui-border-width: var(--kui-border-card);')
    expect(theme).toMatch(/@property --kui-border-width \{\s*syntax: '<length>';/)
  })

  test('draws the info toast in the info colour, the danger and success toasts in theirs', () => {
    const toast = blockOf(theme, '.kui-toast') ?? ''

    expect(blockOf(toast, '&:where([data-tone=\'info\'])')).toContain('--kui-toast-tone: var(--color-kui-info);')
    expect(blockOf(toast, '&:where([data-tone=\'danger\'])')).toContain('--kui-toast-tone: var(--color-kui-error);')
    expect(blockOf(toast, '&:where([data-tone=\'success\'])')).toContain('--kui-toast-tone: var(--color-kui-success);')
  })
})
