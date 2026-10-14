import type { FontConfig, FontsourceConfig } from '../config'
import type { HeadTag } from '../runtime/head'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { writeAsset } from '../build/assets'

// What every page carries for the fonts: their `@font-face` rules and the files to preload.
export interface FontAssets {
  css: string
  preload: { href: string, type: string }[]
  // Each face's file, which share cards are drawn in; a build from before cards has none.
  faces?: { family: string, weight: string, style: string, url: string }[]
}

const FONTS_FILE = 'fonts.json'
const FORMATS: Record<string, string> = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' }
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
      throw new Error(`kay: the font ${font.src} is no .woff2, .woff, .ttf or .otf file`)

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
      preload.push({ href: url, type: `font/${format === 'truetype' ? 'ttf' : format === 'opentype' ? 'otf' : format}` })
  }

  const assets = { css: rules.join(''), preload, faces }

  await Bun.write(join(dir, FONTS_FILE), JSON.stringify(assets))

  return assets
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
  const { fontsource, weights, styles = ['normal'], display } = font
  let file: string

  try {
    file = Bun.resolveSync(`${fontsource}/metadata.json`, root)
  }
  catch {
    throw new Error(`kay: the fonts name ${fontsource}, which is no installed Fontsource package; bun add ${fontsource}`)
  }

  const metadata = JSON.parse(readFileSync(file, 'utf8')) as FontsourceMetadata
  const subsets = typeof font.subset === 'string' ? [font.subset] : font.subset ?? [metadata.defSubset]
  // A static package's metadata describes the family's variable axes too: only a `@fontsource-variable` package ships them.
  const variable = fontsource.startsWith(VARIABLE_SCOPE) ? metadata.variable !== undefined && metadata.variable !== false ? metadata.variable.wght : undefined : undefined

  if (fontsource.startsWith(VARIABLE_SCOPE) && !variable)
    throw new Error(`kay: ${fontsource} has no weight axis to declare`)

  const faces: FontConfig[] = []

  for (const subset of subsets) {
    if (!metadata.subsets.includes(subset))
      throw new Error(`kay: ${fontsource} has no subset ${subset}; it has ${metadata.subsets.join(', ')}`)
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
      throw new Error(`kay: ${fontsource} has no ${style} faces`)

    if (variable) {
      if (weights !== undefined)
        throw new Error(`kay: ${fontsource} is variable, one face spanning weights ${variable.min} to ${variable.max}, so its entry lists no weights`)

      faces.push(...facesOf(`wght-${style}`, { weight: `${variable.min} ${variable.max}`, style, display }))

      continue
    }

    if (weights === undefined || weights.length === 0)
      throw new Error(`kay: ${fontsource} holds a face per weight, so its entry lists the weights the site uses, among ${metadata.weights.join(', ')}`)

    for (const weight of weights) {
      if (!metadata.weights.includes(weight))
        throw new Error(`kay: ${fontsource} has no weight ${weight}; it has ${metadata.weights.join(', ')}`)

      faces.push(...facesOf(`${weight}-${style}`, { weight, style, display }))
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

  throw new Error(`kay: the package of ${metadata.family} names no unicode-range for its ${subset} subset, which a face of several subsets needs`)
}

// A path relative to the root, or a file of an installed package such as `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`.
function fontFile(root: string, src: string): string {
  if (isAbsolute(src) || RELATIVE.test(src) || existsSync(resolve(root, src)))
    return resolve(root, src)

  try {
    return Bun.resolveSync(src, root)
  }
  catch {
    throw new Error(`kay: the font ${src} is neither a file under the project nor one of an installed package`)
  }
}
