import type { FontConfig, FontsourceConfig } from '../config'
import type { HeadTag } from '../runtime/head'
import type { FontMetrics } from './font-metrics'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { writeAsset } from '../build/assets'
import { KayError } from '../compiler/errors'
import { fallbackDescriptors, FALLBACKS, fontMetrics } from './font-metrics'

// What every page carries for the fonts: their `@font-face` rules and the files to preload.
export interface FontAssets {
  css: string
  preload: { href: string, type: string }[]
  // Each face's file, which share cards are drawn in; a build from before cards has none.
  faces?: { family: string, weight: string, style: string, url: string }[]
}

const FONTS_FILE = 'fonts.json'
const FORMATS: Record<string, string> = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' }
const PRELOAD_EXTENSIONS = new Map([['truetype', 'ttf'], ['opentype', 'otf']])
const QUOTE = /["\\]/g
const RELATIVE = /^\.{1,2}\//
const VARIABLE_SCOPE = '@fontsource-variable/'
const NORMAL_STYLE = /-normal$/
// A rule of a Fontsource stylesheet: its woff2 file and its range.
const FACE_RANGE = /url\(([^)]+?\.woff2)\)[^}]*?unicode-range:([^;}]+)/g

// Writes each font as a content-named asset, and records the rules declaring them beside the client build for a server that only reads it.
export async function prepareFonts(root: string, fonts: (FontConfig | FontsourceConfig)[], dir: string): Promise<FontAssets> {
  const rules: string[] = []
  const preload: FontAssets['preload'] = []
  const faces: NonNullable<FontAssets['faces']> = []

  for (const font of fonts.flatMap(font => 'fontsource' in font ? fontsourceFaces(root, font) : [font])) {
    const file = fontFile(root, font.src)
    const format = FORMATS[extname(file).toLowerCase()]

    if (format === undefined)
      throw new KayError('font-invalid', `kay: the font ${font.src} is no .woff2, .woff, .ttf or .otf file`)

    const url = await writeAsset(file, root)
    const declarations = [
      `font-family:"${font.family.replace(QUOTE, '\\$&')}"`,
      `src:url("${url}") format("${format}")`,
      `font-weight:${font.weight ?? 400}`,
      `font-style:${font.style ?? 'normal'}`,
      `font-display:${font.display ?? 'swap'}`,
    ]

    if (font.unicodeRange !== undefined)
      declarations.push(`unicode-range:${font.unicodeRange}`)

    rules.push(`@font-face{${declarations.join(';')}}`)
    faces.push({ family: font.family, weight: String(font.weight ?? 400), style: font.style ?? 'normal', url })

    if (font.preload === true)
      preload.push({ href: url, type: `font/${PRELOAD_EXTENSIONS.get(format) ?? format}` })
  }

  const assets = { css: rules.join('') + [...fontFallbacks(root, fonts).values()].map(({ rule }) => rule).join(''), preload, faces }

  await Bun.write(join(dir, FONTS_FILE), JSON.stringify(assets))

  return assets
}

// The system font drawn in a family's place until its files arrive, fitted to take the room the family will.
export interface FontFallback {
  // The `@font-face` rule declaring it.
  rule: string
  // The family name the rule declares, which a font stack lists right after the family.
  name: string
}

// A file's metrics, read again only once the file changes: its change time and size count beside its modified time, as a font swapped in keeping the old one's modified time is another file.
const METRICS = new Map<string, { stamp: string, metrics: FontMetrics | undefined }>()
// Under this share of English letters the file is a subset without them, and no fallback fits it.
const MIN_COVERAGE = 0.9
const FIRST_NUMBER = /\d+/
// A `@font-face` block, whose `font-family` names one family and is left alone, or a font stack: the property with what precedes it, and the list.
const FONT_STACK = /@font-face\s*\{[^}]*\}|((?:^|[;{\s])(?:font-family|font|--[\w-]*font[\w-]*)\s*:\s*)([^\s;}!][^;}!]*)/g
// The `font` shorthand lists its families after the size, which may carry a line height, and which `var()` or `calc()` may stand for, spaces and one level of nesting included.
const WORD = /(?<text>"[^"]*"|'[^']*'|[\w-]+\((?:[^()]|\([^()]*\))*\)(?:\/\S+)?|\S+)\s*/g
const SIZE_FUNCTION = /^(?:var|calc|min|max|clamp|env)\(/i
const FONT_SIZE = /^(?:(?:\d+\.)?\d+(?:[a-z]+|%)|(?:x{1,3}-)?(?:small|large)|medium|larger|smaller)(?:\/\S+)?$/i
const SHORTHAND_PROPERTY = /(?:^|[;{\s])font\s*:/
const QUOTED = /^(["'])(.*)\1$/

function metricsOf(file: string): FontMetrics | undefined {
  let stamp: string
  let bytes: Buffer

  try {
    const found = statSync(file, { throwIfNoEntry: false })

    if (found === undefined)
      return undefined

    stamp = `${found.mtimeMs}:${found.ctimeMs}:${found.size}`
    bytes = readFileSync(file)
  }
  catch {
    return undefined
  }

  const cached = METRICS.get(file)

  if (cached?.stamp === stamp)
    return cached.metrics

  const metrics = fontMetrics(bytes)

  METRICS.set(file, { stamp, metrics })

  return metrics
}

// A fallback per family, fitted to its face nearest a regular weight that holds the Latin letters; a family none fits, such as a symbol or a non-Latin font, has none.
export function fontFallbacks(root: string, fonts: (FontConfig | FontsourceConfig)[]): Map<string, FontFallback> {
  const families = new Map<string, FontConfig[]>()

  for (const font of fonts.flatMap(font => 'fontsource' in font ? fontsourceFaces(root, font) : [font]))
    families.set(font.family, [...families.get(font.family) ?? [], font])

  const fallbacks = new Map<string, FontFallback>()
  const distance = (font: FontConfig) => Math.abs(Number(FIRST_NUMBER.exec(String(font.weight ?? 400))?.[0] ?? 400) - 400) + (font.style === 'italic' ? 1000 : 0)

  for (const [family, faces] of families) {
    for (const face of faces.toSorted((a, b) => distance(a) - distance(b))) {
      const metrics = metricsOf(fontFile(root, face.src))

      if (metrics === undefined || metrics.coverage < MIN_COVERAGE)
        continue

      const name = `${family} Fallback`
      // The same name on one rule per system face: a rule whose `local()` finds nothing is skipped, and the next one is used.
      const rule = FALLBACKS[metrics.kind].map(fallback => `@font-face{font-family:"${name.replace(QUOTE, '\\$&')}";src:${fallback.names.map(local => `local("${local}")`).join(',')};${fallbackDescriptors(metrics, fallback)}}`).join('')

      fallbacks.set(family, { name, rule })

      break
    }
  }

  return fallbacks
}

// Where the family list of a `font` shorthand starts, or nothing for a value without a size, such as a system font keyword.
function familiesAfterSize(value: string): number | undefined {
  // A function may stand for a weight or a style as well as the size, so a size found later wins, else the last one before the families.
  let afterFunction: number | undefined

  for (const word of value.matchAll(WORD)) {
    const text = word.groups!.text!

    if (text.startsWith('"') || text.startsWith('\'') || text.endsWith(','))
      return afterFunction

    if (FONT_SIZE.test(text))
      return word.index + word[0].length

    if (SIZE_FUNCTION.test(text))
      afterFunction = word.index + word[0].length
  }

  return undefined
}

function unquoted(item: string): string {
  const trimmed = item.trim()

  return QUOTED.exec(trimmed)?.[2] ?? trimmed
}

// Lists each family's fallback right after the family in the font stacks of a stylesheet, `font-family` and the custom properties named for a font, so the text is drawn in it until the family's files arrive.
export function withFontFallbacks(css: string, fallbacks: Map<string, FontFallback>): string {
  if (fallbacks.size === 0)
    return css

  // Family names are case-insensitive.
  const byName = new Map([...fallbacks].map(([family, fallback]) => [family.toLowerCase(), fallback]))

  return css.replace(FONT_STACK, (match, property: string | undefined, stack: string | undefined) => {
    if (property === undefined || stack === undefined)
      return match

    // In the shorthand only the family list follows the size, so the rest is kept as it is.
    const split = SHORTHAND_PROPERTY.test(property) ? familiesAfterSize(stack) : 0

    if (split === undefined)
      return match

    const lead = stack.slice(0, split)
    const items = stack.slice(split).split(',')
    const listed = new Set(items.map(item => unquoted(item).toLowerCase()))
    let changed = false
    const stacked = items.flatMap((item) => {
      const fallback = byName.get(unquoted(item).toLowerCase())

      if (fallback === undefined || listed.has(fallback.name.toLowerCase()))
        return [item]

      changed = true

      return [item, `"${fallback.name}"`]
    })

    return changed ? `${property}${lead}${stacked.join(',')}` : match
  })
}

// The file of every face, for the notices file to credit the packages they come from.
export function fontFiles(root: string, fonts: (FontConfig | FontsourceConfig)[]): string[] {
  return fonts.flatMap(font => 'fontsource' in font ? fontsourceFaces(root, font) : [font]).map(font => fontFile(root, font.src))
}

// What `kay build` recorded, for a server reading no source.
export async function builtFonts(dir: string): Promise<FontAssets | undefined> {
  const file = Bun.file(join(dir, FONTS_FILE))

  return await file.exists() ? await file.json() as FontAssets : undefined
}

// The rules sit in the head, a few hundred bytes that a stylesheet of their own would have the first paint wait a request for (30 to 45 ms on a throttled phone).
// The faces with `preload: true` are fetched before the rules ask for them, so their text renders in its font on the first paint more often; `crossorigin` is what lets the browser reuse a font preload.
export function fontTags(assets: FontAssets): HeadTag[] {
  return [
    ...assets.preload.map(({ href, type }) => ({ tag: 'link', props: { rel: 'preload', href, as: 'font', type, crossorigin: '' } })),
    { tag: 'style', props: { children: assets.css } },
  ]
}

interface FontsourceMetadata {
  id: string
  family: string
  weights: number[]
  styles: string[]
  subsets: string[]
  defSubset: string
  // Recent packages list each subset's range; older ones only write it in their CSS.
  unicodeRange?: Record<string, string> | null
  variable?: { wght?: { min: string, max: string } } | false
}

// One face per weight and style, each the package's own file, or one per style spanning the weights of a variable package.
function fontsourceFaces(root: string, font: FontsourceConfig): FontConfig[] {
  const { fontsource, weights, styles = ['normal'], display, preload } = font
  let file: string

  try {
    file = Bun.resolveSync(`${fontsource}/metadata.json`, root)
  }
  catch {
    throw new KayError('font-invalid', `kay: the fonts name ${fontsource}, which is no installed Fontsource package; bun add ${fontsource}`)
  }

  const metadata = JSON.parse(readFileSync(file, 'utf8')) as FontsourceMetadata

  if (font.subsets !== undefined && font.subset !== undefined)
    throw new KayError('font-invalid', `kay: the font ${fontsource} sets both subsets and its older spelling subset; keep subsets`)

  const named = font.subsets ?? font.subset
  const subsets = typeof named === 'string' ? [named] : named ?? [metadata.defSubset]
  // A static package's metadata describes the family's variable axes too: only a `@fontsource-variable` package ships them.
  const variable = fontsource.startsWith(VARIABLE_SCOPE) && metadata.variable !== undefined && metadata.variable !== false ? metadata.variable.wght : undefined

  if (fontsource.startsWith(VARIABLE_SCOPE) && !variable)
    throw new KayError('font-invalid', `kay: ${fontsource} has no weight axis to declare`)

  const faces: FontConfig[] = []

  for (const subset of subsets) {
    if (!metadata.subsets.includes(subset))
      throw new KayError('font-invalid', `kay: ${fontsource} has no subset ${subset}; it has ${metadata.subsets.join(', ')}`)
  }

  // One subset needs no range, its file holding every character the site uses.
  const ranged = subsets.length > 1
  const facesOf = (name: string, face: Omit<FontConfig, 'src' | 'family'>) => subsets.map(subset => ({
    family: metadata.family,
    src: `${fontsource}/files/${metadata.id}-${subset}-${name}.woff2`,
    ...face,
    ...ranged ? { unicodeRange: subsetRange(file, metadata, subset, name) } : {},
  }))

  for (const style of styles) {
    if (!metadata.styles.includes(style))
      throw new KayError('font-invalid', `kay: ${fontsource} has no ${style} faces`)

    if (variable) {
      if (weights !== undefined)
        throw new KayError('font-invalid', `kay: ${fontsource} is variable, one face spanning weights ${variable.min} to ${variable.max}, so its entry lists no weights`)

      faces.push(...facesOf(`wght-${style}`, { weight: `${variable.min} ${variable.max}`, style, display, preload }))

      continue
    }

    if (weights === undefined || weights.length === 0)
      throw new KayError('font-invalid', `kay: ${fontsource} holds a face per weight, so its entry lists the weights the site uses, among ${metadata.weights.join(', ')}`)

    for (const weight of weights) {
      if (!metadata.weights.includes(weight))
        throw new KayError('font-invalid', `kay: ${fontsource} has no weight ${weight}; it has ${metadata.weights.join(', ')}`)

      faces.push(...facesOf(`${weight}-${style}`, { weight, style, display, preload }))
    }
  }

  return faces
}

// The characters a subset's file holds, from the package's metadata, or else from the stylesheet Fontsource writes for the face, `400.css` or `wght-italic.css`.
function subsetRange(metadataFile: string, metadata: FontsourceMetadata, subset: string, face: string): string {
  const listed = metadata.unicodeRange?.[subset]

  if (listed !== undefined)
    return listed

  const stylesheet = join(dirname(metadataFile), `${face.replace(NORMAL_STYLE, '')}.css`)
  const css = existsSync(stylesheet) ? readFileSync(stylesheet, 'utf8') : ''
  const file = `${metadata.id}-${subset}-${face}.woff2`

  for (const [, src, range] of css.matchAll(FACE_RANGE)) {
    if (src!.endsWith(`/${file}`))
      return range!.trim()
  }

  throw new KayError('font-invalid', `kay: the package of ${metadata.family} names no unicode-range for its ${subset} subset, which a face of several subsets needs`)
}

// A path relative to the root, or a file of an installed package such as `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`.
function fontFile(root: string, src: string): string {
  if (isAbsolute(src) || RELATIVE.test(src) || existsSync(resolve(root, src)))
    return resolve(root, src)

  try {
    return Bun.resolveSync(src, root)
  }
  catch {
    throw new KayError('font-invalid', `kay: the font ${src} is neither a file under the project nor one of an installed package`)
  }
}
