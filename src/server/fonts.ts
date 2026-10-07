import type { FontConfig, FontsourceConfig } from '../config'
import type { HeadTag } from '../runtime/head'
import { existsSync, readFileSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { writeAsset, writeAssetBytes } from '../build/assets'

// What every page links for the fonts: one stylesheet of `@font-face` rules and the files to preload.
export interface FontAssets {
  stylesheet: string
  preload: { href: string, type: string }[]
}

const FONTS_FILE = 'fonts.json'
const FORMATS: Record<string, string> = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' }
const QUOTE = /["\\]/g
const RELATIVE = /^\.{1,2}\//

// Writes each font and the stylesheet declaring them as content-named assets, and records their URLs beside the client build for a server that only reads it.
export async function prepareFonts(root: string, fonts: (FontConfig | FontsourceConfig)[], dir: string): Promise<FontAssets> {
  const rules: string[] = []
  const preload: FontAssets['preload'] = []

  for (const font of fonts.flatMap(font => 'fontsource' in font ? fontsourceFaces(root, font) : [font])) {
    const file = fontFile(root, font.src)
    const format = FORMATS[extname(file).toLowerCase()]

    if (!format)
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

    if (font.preload === true)
      preload.push({ href: url, type: `font/${format === 'truetype' ? 'ttf' : format === 'opentype' ? 'otf' : format}` })
  }

  const assets = { stylesheet: await writeAssetBytes('fonts', '.css', `${rules.join('\n')}\n`, root), preload }

  await Bun.write(join(dir, FONTS_FILE), JSON.stringify(assets))

  return assets
}

// What `kay build` recorded, for a server reading no source.
export async function builtFonts(dir: string): Promise<FontAssets | undefined> {
  const file = Bun.file(join(dir, FONTS_FILE))

  return await file.exists() ? await file.json() as FontAssets : undefined
}

// The faces with `preload: true` are fetched before the stylesheet asks for them, so their text renders in its font on the first paint more often; `crossorigin` is what lets the browser reuse a font preload.
export function fontTags(assets: FontAssets): HeadTag[] {
  return [
    ...assets.preload.map(({ href, type }) => ({ tag: 'link', props: { rel: 'preload', href, as: 'font', type, crossorigin: '' } })),
    { tag: 'link', props: { rel: 'stylesheet', href: assets.stylesheet } },
  ]
}

interface FontsourceMetadata {
  id: string
  family: string
  weights: number[]
  styles: string[]
  subsets: string[]
  defSubset: string
  variable?: { wght?: { min: string, max: string } } | false
}

// One face per weight and style, each the package's own file, or one per style spanning the weights of a variable package.
function fontsourceFaces(root: string, font: FontsourceConfig): FontConfig[] {
  const { fontsource, weights, styles = ['normal'], display } = font
  let metadata: FontsourceMetadata

  try {
    metadata = JSON.parse(readFileSync(Bun.resolveSync(`${fontsource}/metadata.json`, root), 'utf8')) as FontsourceMetadata
  }
  catch {
    throw new Error(`kay: the fonts name ${fontsource}, which is no installed Fontsource package; bun add ${fontsource}`)
  }

  const subset = font.subset ?? metadata.defSubset
  const variable = metadata.variable ? metadata.variable.wght : undefined
  const faces: FontConfig[] = []

  if (!metadata.subsets.includes(subset))
    throw new Error(`kay: ${fontsource} has no subset ${subset}; it has ${metadata.subsets.join(', ')}`)

  for (const style of styles) {
    if (!metadata.styles.includes(style))
      throw new Error(`kay: ${fontsource} has no ${style} faces`)

    if (variable) {
      if (weights !== undefined)
        throw new Error(`kay: ${fontsource} is variable, one face spanning weights ${variable.min} to ${variable.max}, so its entry lists no weights`)

      faces.push({ family: metadata.family, src: `${fontsource}/files/${metadata.id}-${subset}-wght-${style}.woff2`, weight: `${variable.min} ${variable.max}`, style, display })

      continue
    }

    if (weights === undefined || weights.length === 0)
      throw new Error(`kay: ${fontsource} holds a face per weight, so its entry lists the weights the site uses, among ${metadata.weights.join(', ')}`)

    for (const weight of weights) {
      if (!metadata.weights.includes(weight))
        throw new Error(`kay: ${fontsource} has no weight ${weight}; it has ${metadata.weights.join(', ')}`)

      faces.push({ family: metadata.family, src: `${fontsource}/files/${metadata.id}-${subset}-${weight}-${style}.woff2`, weight, style, display })
    }
  }

  return faces
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
