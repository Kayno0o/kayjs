import { describe, expect, test } from 'bun:test'
import { compileKay } from 'kay/compiler'
import { compile } from 'tailwindcss'
import { MENU_FOOTER, MENU_ITEM } from '../src/menu-look'

const ROOT = new URL('..', import.meta.url).pathname

// These list today's families of token names, the app's own words: a class reaching for a new family needs it added here too.
const COLOR = /\b(?:bg|text|border|ring|ring-offset|fill|stroke|outline|caret|accent)-(background|foreground|popover|surface(?:-strong)?|muted|border(?:-strong)?|input|ring|accent(?:-hover|-foreground)?|success|warning|info|danger|hover|chart-\d)\b/g
const SCALE = /\b(text|tracking)-(2xs|label)\b/g
const DEFINED_TOKEN = /(--[\w-]+):/g
const DEFINED_CLASS = /\.([a-z][\w-]*)/g
// A `class` attribute: a quoted string, or an expression of strings, arrays and `{ name: condition }` objects.
const CLASS_STRING_ATTRIBUTE = /\bclass="([^"]*)"/g
const CLASS_EXPRESSION = /\bclass=\{((?:[^{}]|\{[^{}]*\})*)\}/g
// A class name in an expression: a quoted string, unless a comparison makes it a value, or an object key.
const CLASS_IN_EXPRESSION = /([!=]==\s*)?'([a-z][\w-]*)'|\b([a-z][\w-]*)(?=\s*:)/g
const KUI_NAME = /(?<![\w-])kui-[a-z][a-z0-9-]*(?![\w-])/g
const WHITESPACE = /\s+/
const RECIPE_STRING = /'([^']+)'/g
// A line comment of a recipe, whose apostrophe is no string quote.
const LINE_COMMENT = /^\s*\/\/.*$/gm
const COLOUR_TOKEN = /(--color-[\w-]+): ([^;]+);/g
// A colour holds a light and a dark value, or names another colour that does.
const PAIRED = /^light-dark\(|^var\(--color-[\w-]+\)$|^color-mix\(in (?:oklab|srgb), /
// A rule setting color-scheme, with its selector.
const SCHEME = /([^{}\n]*[^{}\s])\s*\{\s*color-scheme: (\w+);/g
// A quoted class name, as a script or a component's own script writes one: `classList.add('x')`, `{ 'x': on }`.
const QUOTED = /'([a-z][\w-]*)'/g
// What chartist draws itself, styled here but written by no source of the library, and Tailwind's `group`, which the app writes on what holds a stamp.
const THIRD_PARTY = /^(?:ct-|group$)/
// The tokens of a skin's offset shadows and press-down, with their value.
const PRESS_TOKEN = /(--(?:shadow-raised|shadow-press|press-travel)): ([^;]+);/g

// A `kui-` class a string or template literal ends on, with more added to it; `--kui-` names an anchor or a token.
const BUILT_CLASS = /(?<![\w-])kui-[\w-]*(?:\$\{|['"`]\s*\+)/g

const HEX = /^#[\da-f]{6}$/i
const RGB_ALPHA = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/
const VAR = /^var\((--color-[\w-]+)(?:, (.*))?\)$/
const MIX_ARGUMENT = /^(\S.*?)(?: ([\d.]+)%)?$/
const GROUNDS = ['popover', 'background', 'surface', 'surface-strong']
const TEXT = ['foreground', 'muted', 'accent', 'danger', 'success', 'warning', 'info']
const LINES = ['input', 'ring']

// The theme namespace a scale utility reads, by its prefix.
const NAMESPACE: Record<string, string> = { text: 'text', tracking: 'tracking' }

const theme = await Bun.file(`${ROOT}src/theme.css`).text()
const paths = await Array.fromAsync(new Bun.Glob('src/**/*.kay').scan({ cwd: ROOT }))
const components = await Promise.all(paths.map(async path => ({ path, source: await Bun.file(`${ROOT}${path}`).text() })))
const scripts = await Promise.all((await Array.fromAsync(new Bun.Glob('src/**/*.ts').scan({ cwd: ROOT }))).map(async path => Bun.file(`${ROOT}${path}`).text()))

const tokens = new Set([...theme.matchAll(DEFINED_TOKEN)].map(([, token]) => token))
const classes = new Set([...theme.matchAll(DEFINED_CLASS)].map(([, name = '']) => name))

// Classes a component writes that no rule of the theme selects any more: rule-free names for an app's CSS and skins.
const HOOKS = new Set(['kui-menu', 'kui-toaster', 'kui-tooltip', 'kui-card', 'kui-card-row', 'kui-widget', 'kui-notice', 'kui-avatar', 'kui-checkbox', 'kui-radio-group', 'kui-chip', 'kui-chip-group', 'kui-copy-btn', 'kui-empty-state', 'kui-file-drop', 'kui-meter', 'kui-progress', 'kui-skeleton', 'kui-page-header', 'kui-page-section', 'kui-date-input', 'kui-date-range-input', 'kui-segmented', 'kui-slider', 'kui-color-input', 'kui-combobox', 'kui-rating', 'kui-toggle', 'kui-contact-form', 'kui-contact-consent', 'kui-contact-privacy'])

// The source of a component of the library.
const sourceOf = (name: string): string => components.find(component => component.path === `src/${name}.kay`)!.source

// The components whose look is a recipe of utilities (#1885), each with its part classes in REMOVED_UI_CLASSES; theme.css has no rule for their part classes.
const RECIPE_COMPONENTS = new Set(['src/card.kay', 'src/badge.kay', 'src/notice.kay', 'src/avatar.kay', 'src/stat.kay', 'src/page-header.kay', 'src/page-section.kay', 'src/empty-state.kay', 'src/card-row.kay', 'src/widget.kay', 'src/meter.kay', 'src/progress.kay', 'src/skeleton.kay', 'src/button.kay', 'src/form-field.kay', 'src/checkbox.kay', 'src/toggle.kay', 'src/text-input.kay', 'src/textarea.kay', 'src/select.kay', 'src/contact-form.kay', 'src/radio-group.kay', 'src/segmented.kay', 'src/rating.kay', 'src/slider.kay', 'src/color-input.kay', 'src/date-input.kay', 'src/date-range-input.kay', 'src/combobox.kay', 'src/multi-select.kay', 'src/chip-group.kay', 'src/file-drop.kay', 'src/copy-button.kay', 'src/confirm-delete.kay', 'src/dialog.kay', 'src/form-dialog.kay', 'src/menu.kay', 'src/popover.kay', 'src/hover-card.kay', 'src/side-panel.kay', 'src/command-palette.kay', 'src/toaster.kay', 'src/tooltip-host.kay', 'src/toolbar.kay'])

// Tables and navigation (slice 5 of #1885).
for (const path of ['table', 'tabs', 'tab-nav', 'breadcrumb', 'pagination', 'steps', 'site-nav', 'app-header'])
  RECIPE_COMPONENTS.add(`src/${path}.kay`)

// Charts and media (slice 6).
for (const path of ['bar-list', 'bar-chart', 'scatter-chart', 'contribution-graph', 'line-chart', 'carousel', 'media-gallery', 'image-cropper', 'zoom-pane', 'masonry', 'qr-code', 'site-favicon'])
  RECIPE_COMPONENTS.add(`src/${path}.kay`)

// Every class a component writes: the `.class` shorthand, plain `class` attributes, and the names a `class` expression holds.
function writtenClasses(path: string, source: string): string[] {
  const template = source.slice(source.lastIndexOf('\n---\n') + 1)
  const plain = [...template.matchAll(CLASS_STRING_ATTRIBUTE)].flatMap(([, value = '']) => value.split(WHITESPACE))
  const expressions = [...template.matchAll(CLASS_EXPRESSION)].flatMap(([, expression = '']) => [...expression.matchAll(CLASS_IN_EXPRESSION)].filter(([, compared]) => compared === undefined).map(([, , quoted, key]) => quoted ?? key!))

  const all = [...compileKay(source, path).classes, ...plain, ...expressions].filter(Boolean)

  // A recipe holds the utilities of a component it moved; only its `kui-` hook is a class theme.css defines.
  return RECIPE_COMPONENTS.has(path) ? [...all, ...source.match(KUI_NAME) ?? []].filter(name => name.startsWith('kui-')) : all
}

// The seeds a skin sets alone; every other colour derives from them.
const SEEDS = ['background', 'foreground', 'accent', 'success', 'warning', 'info', 'danger', 'input']

type Tokens = Map<string, string>

// The colour tokens of a block of CSS: the default block of the theme alone, before the old names it keeps as aliases.
const colourDeclarations = (css: string): [string, string][] => [...css.matchAll(COLOUR_TOKEN)].map(([, token = '', value = '']) => [token, value.trim()])

// A colour once the old name and the template's own names it reads first are peeled off: what is left is its value, or the colour it names.
function peeled(value: string): string {
  const next = (/^var\(--color-[\w-]+, ([\s\S]*)\)$/).exec(value)?.[1]

  return next === undefined ? value : peeled(next)
}

const colourTokens: Tokens = new Map(colourDeclarations(theme.slice(0, theme.indexOf('@theme default inline reference'))))

// The theme's colours under a skin's own declarations, `--color-name: value;`.
function withSkin(skin: string): Tokens {
  return new Map([...colourTokens, ...colourDeclarations(skin)])
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

  // A name the skin or the theme sets, else its fallback: the theme reads the old name and the template's first and ends on the value.
  if (named) {
    const value = tokens.get(named[1]!)

    return evaluate(value ?? named[2]!, scheme, tokens)
  }

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
  const { rgb, alpha } = evaluate(`var(--color-${name})`, scheme, tokens)

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

// The CSS the utilities generate beyond the theme's own rules, which hold the same declarations for the old kui- classes.
async function utilitiesOf(candidates: string[]): Promise<string> {
  const tailwind = Bun.resolveSync('tailwindcss/theme.css', ROOT)
  const compiler = await compile(`@import 'tailwindcss/theme.css' layer(theme);\n${theme}\n@tailwind utilities;`, { base: ROOT, loadStylesheet: async (_, base) => ({ path: tailwind, base, content: await Bun.file(tailwind).text() }) })
  const had = new Set(compiler.build([]).split('\n'))

  return compiler.build(candidates).split('\n').filter(line => !had.has(line)).join('\n')
}

// The theme as Tailwind compiles it, with a skin's own CSS after it, or before it.
async function built(skin: string, where: 'after' | 'before' = 'after', candidates: string[] = []): Promise<string> {
  const tailwind = Bun.resolveSync('tailwindcss/theme.css', ROOT)
  const compiler = await compile(`@import 'tailwindcss/theme.css' layer(theme);\n${where === 'before' ? `${skin}\n${theme}` : `${theme}\n${skin}`}`, { base: ROOT, loadStylesheet: async (_, base) => ({ path: tailwind, base, content: await Bun.file(tailwind).text() }) })

  return compiler.build(candidates)
}

describe('theme.css', () => {
  test('reads at 4.5:1 for text and 3:1 for field borders and focus, on every ground in both schemes', () => {
    expect(failing(TEXT, 4.5)).toEqual([])
    expect(failing(LINES, 3)).toEqual([])

    for (const scheme of [0, 1] as const) {
      for (const fill of ['accent', 'accent-hover', 'danger', 'success', 'warning', 'info', 'muted'])
        expect(contrast(colour('accent-foreground', scheme), colour(fill, scheme))).toBeGreaterThanOrEqual(4.5)

      // A hovered accent button shows it is hovered.
      expect(contrast(colour('accent', scheme), colour('accent-hover', scheme))).toBeGreaterThanOrEqual(1.4)
    }
  })

  test('derives every colour but the seeds from them, so a skin sets eight colours and not twenty', () => {
    const own = [...colourTokens].filter(([, value]) => !peeled(value).includes('var(--color-'))

    expect(own.map(([token]) => token.slice('--color-'.length)).toSorted()).toEqual([...SEEDS, 'chart-5', 'chart-6'].toSorted())
  })

  test('keeps the look the literals gave, each derived colour within a few steps of its old value in both schemes', () => {
    // The palette before it derived: [light, dark], composited over the canvas where translucent; the accent's hover is the accent shaded.
    const WAS: Record<string, [number[], number[]]> = {
      'popover': [[0xEF, 0xEC, 0xE6], [0x0D, 0x0D, 0x0D]],
      'surface': [[0xF4, 0xF1, 0xEC], [0x16, 0x16, 0x16]],
      'surface-strong': [[0xEC, 0xE8, 0xE1], [0x1B, 0x1B, 0x1B]],
      'border': [[0xE1, 0xDF, 0xDB], [0x2B, 0x2B, 0x2B]],
      'border-strong': [[0xC5, 0xC3, 0xBF], [0x45, 0x45, 0x45]],
      'muted': [[0x62, 0x5D, 0x55], [0x9C, 0x97, 0x8E]],
      'accent-hover': [[0x7D, 0x2A, 0x22], [0xF8, 0xC0, 0xB8]],
      'accent-foreground': [[0xFF, 0xFF, 0xFF], [0x1A, 0x0D, 0x0B]],
      'hover': [[0xF0, 0xEE, 0xEA], [0x1D, 0x1D, 0x1D]],
    }

    for (const [name, was] of Object.entries(WAS)) {
      for (const scheme of [0, 1] as const) {
        const now = colour(name, scheme, colour('background', scheme))
        const furthest = Math.max(...now.map((channel, index) => Math.abs(channel - was[scheme][index]!)))

        expect(furthest, `${name} ${scheme === 0 ? 'light' : 'dark'}`).toBeLessThanOrEqual(name === 'accent-foreground' ? 11 : 10)
      }
    }
  })

  test('reads at the same contrast from a skin that sets the seeds alone, in both schemes', () => {
    const skins = [
      '--color-background: light-dark(#fffdf7, #1a1814); --color-foreground: light-dark(#26211a, #ece6d8); --color-accent: light-dark(#9a3412, #fb923c); --color-success: light-dark(#3f6212, #a3e635); --color-warning: light-dark(#854d0e, #facc15); --color-info: light-dark(#1d4ed8, #93c5fd); --color-danger: light-dark(#b91c1c, #fca5a5); --color-input: light-dark(#85776a, #8a7e70);',
      '--color-background: light-dark(#f3f6fa, #0b1220); --color-foreground: light-dark(#0f1b2d, #dbe4f0); --color-accent: light-dark(#1d4ed8, #7aa2f7); --color-success: light-dark(#166534, #86efac); --color-warning: light-dark(#92400e, #fcd34d); --color-info: light-dark(#0b5f78, #67e8f9); --color-danger: light-dark(#b91c1c, #fda4af); --color-input: light-dark(#6b7d94, #5f7390);',
    ]

    for (const skin of skins) {
      const tokens = withSkin(skin)

      expect(failing(TEXT, 4.5, tokens), skin).toEqual([])
      expect(failing(LINES, 3, tokens), skin).toEqual([])

      for (const scheme of [0, 1] as const) {
        for (const fill of ['accent', 'accent-hover'])
          expect(contrast(colour('accent-foreground', scheme, undefined, tokens), colour(fill, scheme, undefined, tokens)), `${skin} ${fill}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('reads from a skin of one scheme that writes its seeds once and pins color-scheme to it', () => {
    const tokens = withSkin('--color-background: #ffffff; --color-foreground: #111111; --color-accent: #a21caf; --color-success: #166534; --color-warning: #92400e; --color-info: #1d4ed8; --color-danger: #b91c1c; --color-input: #767676;')

    expect(failing(TEXT, 4.5, tokens, [0])).toEqual([])
    expect(failing(LINES, 3, tokens, [0])).toEqual([])
    expect(contrast(colour('accent-foreground', 0, undefined, tokens), colour('accent-hover', 0, undefined, tokens))).toBeGreaterThanOrEqual(4.5)
  })

  test('derives from whichever seeds a skin sets and keeps the default for the others', () => {
    const tokens = withSkin('--color-background: light-dark(#ffffff, #000000);')

    expect(colour('surface', 0, undefined, tokens)).not.toEqual(colour('surface', 0))
    expect(colour('surface', 1, undefined, tokens).every(Number.isFinite)).toBe(true)
    // Black is darker than the default background, so the dark surface sits between the two.
    expect(colour('surface', 1, undefined, tokens)[0]!).toBeLessThan(colour('surface', 1)[0]!)
    expect(colour('accent', 0, undefined, tokens)).toEqual(colour('accent', 0))
  })

  test('lets a token the skin sets beat what derives it, in the compiled CSS wherever the skin sits', async () => {
    for (const where of ['after', 'before'] as const) {
      const css = await built('@theme { --color-background: #fff; --color-surface: red; }', where)

      expect(css, where).toContain('--color-surface: red;')
      expect(css, where).toContain('--color-background: #fff;')
      expect(css, where).not.toMatch(/--color-surface: (?:var\([^)]*, )?color-mix/)
    }
  })

  test('fills a solid badge with its tone, its text read from the accent\'s foreground', () => {
    const badge = sourceOf('badge')

    expect(badge).toMatch(/data-solid:\[background-color:var\(--_badge-color,[^\]]*\] data-solid:\[border-color:[^\]]*\] data-solid:\[color:var\(--color-accent-foreground\)\]/)

    for (const tone of ['accent', 'success', 'warning', 'danger', 'info'])
      expect(badge, tone).toContain(`${tone}: '[--_badge-color:var(--color-${tone})]'`)
  })

  test('draws the controls a hairline would leave under 3:1 with the field border', () => {
    expect(blockOf(theme, '.kui-btn')).toMatch(/\b(?:bg|border|text)-input\b|color-input/)

    for (const name of ['carousel', 'toggle', 'rating'])
      expect(sourceOf(name), name).toMatch(/\b(?:bg|border|text)-input\b|color-input/)
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
    expect([...written].filter(name => !classes.has(name) && !HOOKS.has(name))).toEqual([])
  })

  test('defines no class that nothing writes', async () => {
    // field-look.ts holds the recipes the form components share, so its kui- hooks are written there.
    const fieldLook = (await Bun.file(`${ROOT}src/field-look.ts`).text()).match(KUI_NAME) ?? []
    const written = new Set([...components.flatMap(({ path, source }) => writtenClasses(path, source)), ...fieldLook])
    const quoted = new Set([...components.map(({ source }) => source), ...scripts].flatMap(source => [...source.matchAll(QUOTED)].map(([, name]) => name)))

    expect([...classes].filter(name => !written.has(name) && !quoted.has(name) && !THIRD_PARTY.test(name))).toEqual([])
  })

  // kay leaves out the rules of the classes no file writes whole, so a class put together at runtime would lose its own.
  test('writes every class whole, never putting one together at runtime', () => {
    expect([...components.map(({ source }) => source), ...scripts].flatMap(source => source.match(BUILT_CLASS) ?? [])).toEqual([])
  })

  test('gives every colour a light and a dark value, or names another colour', () => {
    const colours = [...theme.slice(0, theme.indexOf('@theme default inline reference')).matchAll(COLOUR_TOKEN)].map(([whole = '', token = '', value = '']) => [whole, token, peeled(value.trim())] as const)

    expect(colours.length).toBeGreaterThan(0)
    expect(colours.filter(([, , value = '']) => !PAIRED.test(value)).map(([, token]) => token)).toEqual([])
  })

  test('is dark unless the system asks for light, and an explicit data-theme wins over both', () => {
    const scheme = [...theme.matchAll(SCHEME)].map(([, selector = '', value]) => `${selector.trim()} ${value}`)

    expect(scheme).toEqual([':root dark', ':root light', '[data-theme=\'light\'] light', '[data-theme=\'dark\'] dark'])
    expect(theme.indexOf('@media (prefers-color-scheme: light)')).toBeLessThan(theme.indexOf('[data-theme=\'light\']'))
  })

  test('declares its tokens as defaults, so the app\'s own @theme wins wherever it sits', async () => {
    const skin = '@theme { --color-accent: red; }'

    for (const where of ['after', 'before'] as const) {
      const css = await built(skin, where)

      expect(css, where).toContain('--color-accent: red;')
      expect(css, where).not.toMatch(/--color-accent: (?:var\([^)]*, )?light-dark/)
    }
  })

  test('marks the focused menu item and the selected palette option with an accent bar, and an outline forced colours paint', async () => {
    const recipeOf = async (path: string, part: string) => (await Bun.file(`${ROOT}${path}`).text()).match(new RegExp(`\\n\\s+${part}: '([^']+)'`))![1]!.split(WHITESPACE)
    const marks = [
      ['a Menu item', MENU_ITEM.split(WHITESPACE), ':focus-visible'],
      ['the BellInbox footer', MENU_FOOTER.split(WHITESPACE), ':focus-visible'],
      ['a palette option', await recipeOf('src/command-palette.kay', 'option'), '[aria-selected'],
    ] as const

    for (const [name, candidates, state] of marks) {
      const css = await utilitiesOf(candidates)

      // Each declaration sits in the rule of the state that marks the item.
      for (const declaration of ['box-shadow: inset 2px 0 0 var(--color-accent);', 'outline: 2px solid transparent;']) {
        const rules = css.split('\n.').filter(rule => rule.slice(0, rule.indexOf('{')).includes(state))

        expect(rules.some(rule => rule.includes(declaration)), `${name} ${state} ${declaration}`).toBe(true)
      }
    }
  })

  test('has Menu and BellInbox draw their list and items from the shared menu-look source, not a copy', async () => {
    const menu = await Bun.file(`${ROOT}src/menu.kay`).text()
    const bell = await Bun.file(`${ROOT}src/bell-inbox.kay`).text()

    for (const line of ['list: MENU_LIST,', 'item: `${MENU_ITEM} '])
      expect(menu, line).toContain(line)

    for (const line of ['list: MENU_LIST,', 'item: MENU_ITEM,', 'all: MENU_FOOTER,'])
      expect(bell, line).toContain(line)
  })

  test('sets the toast tone colour from the tone a toast carries', async () => {
    const toast = (await Bun.file(`${ROOT}src/toaster.kay`).text()).match(/\n\s+toast: '([^']+)'/)![1]!.split(WHITESPACE)
    const css = await utilitiesOf(toast)

    for (const tone of ['danger', 'success', 'info'])
      expect(css, tone).toMatch(new RegExp(String.raw`\[data-tone[=~]?"?${tone}"?\][^{]*\{[^}]*--_toast-tone: var\(--color-${tone}\)`))

    expect(css).toMatch(/--_toast-tone: var\(--color-accent\)/)
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
    expect(sourceOf('form-field')).toMatch(/^ {4}head: '[^']*\bp-0\b/m)
  })

  test('draws no offset shadow nor press-down unless a skin sets their tokens alone', async () => {
    const build = async (skin: string) => [...(await built(skin)).matchAll(PRESS_TOKEN)].map(([, token, value]) => `${token} ${value}`)

    expect(await build('')).toEqual(['--shadow-raised none', '--shadow-press none', '--press-travel 0px'])
    expect(await build('@theme { --shadow-raised: 4px 4px 0 black; --shadow-press: 3px 3px 0 black; --press-travel: 3px; }')).toEqual(['--shadow-raised 4px 4px 0 black', '--shadow-press 3px 3px 0 black', '--press-travel 3px'])
    expect(blockOf(theme, '.kui-toast')).toContain('box-shadow: var(--shadow-raised);')

    for (const name of ['card', 'card-row', 'widget'])
      expect(sourceOf(name), name).toContain('[box-shadow:var(--shadow-raised)]')

    const press = blockOf(theme, '.kui-icon-btn:where(.kui-shell)')

    expect(press).toContain('box-shadow: var(--shadow-press);')
    expect(blockOf(press ?? '', '&:active')).toContain('translate: 0 var(--press-travel);')
  })

  test('draws the hairline and fill of a Button, a framed IconButton and a stat badge from --shell-line and --shell-fill, which src/ui.ts sets as utilities', async () => {
    const skin = await Bun.file(`${ROOT}src/skins/space.css`).text()

    expect(theme + skin).not.toContain('--_shell-')
    expect(blockOf(theme, '.kui-btn')).toContain('--shell-line: var(--color-input);')
    expect(blockOf(theme, ':is(.kui-shell, .kui-btn, .kui-stat-badge)::before')).toContain('border: var(--border-width) solid var(--shell-line);')
    expect(theme).toContain('background-color: var(--shell-fill);')
    expect(skin).toContain('--shell-line: var(--color-input);')
  })

  test('rounds buttons by --radius-md and cards and overlays by --radius-lg, Tailwind\'s own steps unless the app sets them', async () => {
    // The recipes are not scanned here, so a rule applies the step for the theme to emit it.
    const css = await built('@theme { --radius-md: 4px; --radius-lg: 1rem; } .recipe { @apply rounded-lg; }')
    const roundedBy = (token: string) => [...css.matchAll(new RegExp(String.raw`([^{}]+)\{[^{}]*border-radius: var\(${token}\)[^{}]*\}`, 'g'))].map(([, selectors]) => selectors).join(',')

    for (const name of ['kui-btn', 'kui-shell', 'kui-stat-badge'])
      expect(roundedBy('--radius-md'), name).toContain(`.${name}`)

    // The cards and overlays whose recipe draws their look round themselves by the same step.
    for (const name of ['card', 'card-row', 'widget', 'notice', 'toaster', 'dialog', 'command-palette', 'popover', 'hover-card'])
      expect(sourceOf(name), name).toContain('rounded-lg')

    expect(css).toContain('--radius-md: 4px')
    expect(css).toContain('--radius-lg: 1rem')
    // An app that sets nothing gets Tailwind\'s steps.
    expect(theme).toContain('--radius-lg: 0.5rem;')
    // The hairline drawn over a shell follows its corners.
    expect(blockOf(theme, ':is(.kui-shell, .kui-btn, .kui-stat-badge)::before')).toContain('border-radius: inherit;')
  })

  test('steps the radius of what sits inside a box by --radius-sm and -md, and a round avatar by rounded-full', async () => {
    const css = await built('@theme { --radius-sm: 2px; --radius-md: 6px; }')

    expect(theme).toContain('--radius-sm: 0.25rem;')
    expect(theme).toContain('--radius-md: 0.375rem;')
    expect(css).toMatch(/--radius-sm: 2px/)
    expect(css).toMatch(/--radius-md: 6px/)
    expect(sourceOf('chip-group')).toContain('rounded-md')
    expect(sourceOf('toggle')).toContain('rounded-md')
    expect(blockOf(theme, ':where(.kui-badge)')).toContain('rounded-sm')
    expect(await Bun.file(`${ROOT}src/avatar.kay`).text()).toContain('rounded-[calc(infinity*1px)]')
  })

  test('reads the monospace from --font-mono, and the text font of labels and fields as inherit', async () => {
    const css = await built('@theme { --font-mono: Menlo; }')

    expect(theme).toContain('--font-mono: ui-monospace,')
    expect(css).toContain('font-family: var(--font-mono)')
    expect(css).toContain('--font-mono: Menlo')
    expect(theme).toContain('[font-family:var(--font-label,inherit)]')
  })

  test('scales the card, inline and section gaps and the field insets by --density, 1 unless set', async () => {
    const css = await built('@theme { --density: 0.75; }')

    expect(theme).toContain('--density: 1;')
    expect(css).toContain('--density: 0.75')
    expect(theme).toContain('px-[calc(var(--spacing)*2.25*var(--density))]')
    expect(theme).toContain('py-[calc(var(--spacing)*var(--density))]')
  })

  test('sets the case and font of labels, headings and table heads by --label-case and --font-label, uppercase unless a skin sets them', async () => {
    const css = await built('@theme { --label-case: none; --font-label: var(--font-mono); }')

    expect(theme).toContain('--label-case: uppercase;')
    expect(blockOf(css, '.kui-btn')).toContain('text-transform: var(--label-case)')
    expect(blockOf(css, '.kui-btn')).toContain('font-family: var(--font-label,inherit)')
    expect(css).toContain('--label-case: none')
    // Only the stamp badge keeps its own case.
    expect(theme.match(/@apply [^\n]* uppercase/g)).toBeNull()
    expect(sourceOf('badge')).toContain('data-stamp:uppercase')
  })

  test('ships skins that read at 4.5:1 for text and 3:1 for lines, and compile over the theme', async () => {
    for (const name of ['brutalist', 'soft', 'space']) {
      const skin = await Bun.file(`${ROOT}src/skins/${name}.css`).text()
      const tokens = withSkin(skin)

      expect(failing(TEXT, 4.5, tokens), name).toEqual([])
      expect(failing(LINES, 3, tokens), name).toEqual([])

      for (const [, token] of skin.matchAll(/^\s*(--[\w-]+):/gm)) {
        // The label font has no default: it falls back to inherit where it is read. --font-sans is Tailwind's own.
        if (!token!.startsWith('--_') && token !== '--font-label' && token !== '--font-sans')
          expect(theme, `${name} ${token}`).toContain(`${token}:`)
      }

      for (const scheme of [0, 1] as const) {
        for (const fill of ['accent', 'accent-hover'])
          expect(contrast(colour('accent-foreground', scheme, undefined, tokens), colour(fill, scheme, undefined, tokens)), `${name} ${fill}`).toBeGreaterThanOrEqual(4.5)
      }

      expect(await built(skin), name).toContain('--label-case:')
    }

    expect(await built(await Bun.file(`${ROOT}src/skins/soft.css`).text())).toContain('--label-case: none')
    expect(await built(await Bun.file(`${ROOT}src/skins/soft.css`).text())).toContain('--tracking-label: 0.02em')
    expect(await built(await Bun.file(`${ROOT}src/skins/brutalist.css`).text())).toContain('--font-label: var(--font-mono)')
  })

  test('ships the space skin as one scheme with a starfield utility, keys, drawn checkboxes and themed selects, each overridable after it', async () => {
    const skin = await Bun.file(`${ROOT}src/skins/space.css`).text()
    const tailwind = Bun.resolveSync('tailwindcss/theme.css', ROOT)
    const compiler = await compile(`@import 'tailwindcss/theme.css' layer(theme);\n${theme}\n${skin}\n@theme { --color-accent: red; }\n@tailwind utilities;`, { base: ROOT, loadStylesheet: async (_, base) => ({ path: tailwind, base, content: await Bun.file(tailwind).text() }) })
    const css = compiler.build(['starfield'])

    expect(css).toMatch(/\.starfield \{[^}]*background-size: 97px 97px, 131px 131px, 173px 173px, 211px 211px/)
    expect(css).toMatch(/data-theme=.light.\][^{]*\{\s*color-scheme: dark/)
    expect(skin).toContain('--font-sans: \'Space Grotesk\'')
    expect(css).toContain('--color-accent: red')
    expect(css).not.toContain('--color-accent: #bcd4ff')
    expect(css).toContain('appearance: base-select')
    expect(css).toContain('linear-gradient(45deg')
    expect(css).toContain('clip-path: polygon(14% 44%')
    expect(css).toMatch(/--border-width: 0px/)
    // Every class its selectors name exists in the theme, and the mantle is a step under the canvas so boxes on it keep an edge.
    for (const [, name = ''] of skin.matchAll(/\.(kui-[\w-]+)/g))
      expect(classes.has(name) || HOOKS.has(name), name).toBe(true)

    expect(skin).toMatch(/--color-popover: color-mix\(in oklab, var\(--color-background\), black/)
    expect(css).toContain('@media (forced-colors: active)')
    expect(css).toMatch(/\.kui-icon-btn\.kui-shell/)
    expect(css).toContain(':not([multiple], [size])')
    // The skin sets one colour scheme, so it never asks for light.
    expect(skin).not.toContain('light-dark(')
  })

  test('keeps the space skin on the parts the recipes draw: the line they read, the combobox list and the multi-select checkbox', async () => {
    const skin = await Bun.file(`${ROOT}src/skins/space.css`).text()
    const source = async (name: string) => Bun.file(`${ROOT}src/${name}.kay`).text()

    expect(skin).toMatch(/--_control-line: var\(--color-input\)/)

    for (const name of ['segmented', 'chip-group', 'file-drop'])
      expect(await source(name), name).toContain('--_control-line')

    // A part a skin selects by data-part is one the component still sets.
    expect(await source('combobox')).toMatch(/^ {4}list: /m)
    expect(await source('multi-select')).toMatch(/^ {4}checkbox: /m)
    expect(skin).toContain(`.kui-combobox [data-part='list']`)
    expect(skin).toContain(`.kui-multi-select [data-part='checkbox']`)
  })

  test('sizes the keyline of every framed box by --border-width, a length', () => {
    const KEYLINE = /border(?:-[bl])?-\[length:var\(--border-width\)\]/

    for (const selector of ['.kui-table-wrap', '.kui-collapsible-section', '.kui-save-bar', ':where(.kui-site-nav > [data-part=\'list\']:popover-open)'])
      expect(blockOf(theme, selector), selector).toMatch(KEYLINE)

    for (const name of ['card', 'card-row', 'widget', 'segmented', 'file-drop', 'toaster', 'dialog', 'command-palette', 'popover', 'side-panel', 'tooltip-host', 'pagination', 'line-chart'])
      expect(sourceOf(name), name).toMatch(KEYLINE)

    expect(theme).toContain('--border-width: 1px;')
  })

  test('draws the info toast in the info colour, the danger and success toasts in theirs', () => {
    const toast = sourceOf('toaster')

    expect(toast).toContain('data-[tone=info]:[--_toast-tone:var(--color-info)]')
    expect(toast).toContain('data-[tone=danger]:[--_toast-tone:var(--color-danger)]')
    expect(toast).toContain('data-[tone=success]:[--_toast-tone:var(--color-success)]')
  })

  // The recipes read these as a tone of their own element: inherited, a Badge or a Notice inside a toned one would take its colours, and a theme rule setting one would hide the recipe's neutral fallback.
  test('registers the tone variables of the recipes as not inherited, and leaves them out of the old rules', () => {
    for (const name of ['--_badge-color', '--_notice-tone', '--_notice-ground']) {
      expect(theme, name).toMatch(new RegExp(`@property ${name} \\{\\s*syntax: '\\*';\\s*inherits: false;\\s*\\}`))
      expect(theme.replace(/@property[^}]*\}/g, ''), name).not.toContain(name)
    }
  })

  // Tailwind drops a utility reading a token the theme lacks without a word, so a recipe naming one would only lose its look.
  test('compiles every utility of a recipe component against the theme', async () => {
    const tailwind = Bun.resolveSync('tailwindcss/theme.css', ROOT)
    const compiler = await compile(`@import 'tailwindcss/theme.css' layer(theme);\n${theme}\n@tailwind utilities;`, { base: ROOT, loadStylesheet: async (_, base) => ({ path: tailwind, base, content: await Bun.file(tailwind).text() }) })
    let css = compiler.build([])
    const missing: string[] = []
    const seen = new Set<string>()

    for (const path of RECIPE_COMPONENTS) {
      const source = components.find(component => component.path === path)!.source
      const start = source.indexOf('recipe({')
      const recipe = source.slice(start, Math.min(...['defaults:', '\n})', '\n\nconst', '\n---'].map(end => source.indexOf(end, start)).filter(end => end !== -1)))

      for (const name of new Set([...recipe.replace(LINE_COMMENT, '').replaceAll('\'\'', '').matchAll(RECIPE_STRING)].flatMap(([, value = '']) => value.split(WHITESPACE)).filter(name => name !== '' && !name.startsWith('kui-') && !name.startsWith('group/') && !name.startsWith('peer/')))) {
        const next = compiler.build([name])

        if (next.length === css.length && !seen.has(name))
          missing.push(`${path} ${name}`)

        seen.add(name)
        css = next
      }
    }

    expect(missing).toEqual([])
    // Tailwind turns an underscore into a space, which a private name like --_x must not meet.
    expect(css).not.toMatch(/-- [a-z]/)
    expect(css).toMatch(/position-anchor: ?--tooltip-anchor/)
    // A tone sets a variable the colours of the base and of the stamp read, so it beats neither by the order of the classes.
    expect(css).toContain('--_badge-color')
    expect(css).toMatch(/\[data-stamp\]\s*\{[^}]*border-color: var\(--_badge-color,var\(--color-foreground\)\)/)
  })
})

describe('the properties of the recipes', () => {
  test('writes the height of a field once, in a private property the select recipe and the button row read', async () => {
    const select = await Bun.file(`${ROOT}src/select.kay`).text()
    const property = select.match(/min-h-\((--_[\w-]+)\)/)?.[1] ?? ''
    const css = await built('', 'after', [`min-h-(${property})`])
    const escaped = property.replaceAll('-', '\\-')

    expect(property).not.toBe('')
    // One definition, on the field, select and button selectors, none of them wrapped in :where() that pruning would skip.
    expect(css.match(new RegExp(`${escaped}: calc\\(`, 'g'))).toHaveLength(1)
    expect(css).toMatch(new RegExp(`\\.kui-field-input,\\s*\\.kui-form-field select,\\s*\\.kui-btn \\{\\s*${escaped}: `))
    // The select recipe and the button row read it.
    expect(css).toMatch(new RegExp(`min-height: var\\(${escaped}\\)`))
    expect(css).toMatch(new RegExp(`> \\.kui-btn[^{]*\\{\\s*height: var\\(${escaped}\\)`))
  })

  test('keeps the chart series colours in the build, an own override of one included', async () => {
    for (const css of [await built(''), await built('@theme { --color-chart-1: red; }')]) {
      for (const index of [2, 3, 4, 5, 6])
        expect(css, `chart-${index}`).toMatch(new RegExp(`--color-chart-${index}: `))
    }

    expect(await built('@theme { --color-chart-1: red; }')).toContain('--color-chart-1: red')
  })
})
