import type { CheckDiagnostic, CheckOptions } from '.'
import type { NamedAttribute } from '../compiler/ast'
import type { ServedProject } from './shadow-types'
import { stat } from 'node:fs/promises'
import { findKayFiles, findProjectFiles } from '../build/files'
import { walkNodes } from '../compiler/ast'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'

// Past this a raster is worth resizing: the image route serves the same picture as WebP at the width a page shows it, at most 2560 pixels, and a variant at 1280 pixels is seldom above 150 KiB.
export const LARGE_IMAGE_BYTES = 256 * 1024
const RASTER = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i
const QUERY_OR_HASH = /[?#].*$/
const TRAILING_SLASHES = /\/+$/
const SOCIAL_IMAGE = /^(?:og|twitter):image(?::url)?$/i
const STYLE_OR_MARKDOWN = /\.(?:css|md|mdx)$/i
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g
const MARKDOWN_CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g
const NOT_NEWLINE = /[^\n]/g
const URL_CALL = /url\(/i
const CSS_URL = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')\s]+))\s*\)/gi
const MARKDOWN_IMAGE_OR_CSS_URL = new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?([^)\\s>]+)|${CSS_URL.source}`, 'gi')

// Code a reader does not load is blanked, keeping every offset.
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, span => span.replaceAll(NOT_NEWLINE, ' '))
}

// A url as the server compares it, percent-escapes decoded; a malformed escape is left as written.
function decoded(url: string): string {
  try {
    return decodeURIComponent(url)
  }
  catch {
    return url
  }
}

// The `img` of a template whose static `src` is a public raster over `LARGE_IMAGE_BYTES`, which is served as it is: the file is sent whole to every visitor, however small it is drawn.
// An `img` with its own `srcset` is left alone, as is a `src` written as an expression.
export async function largePublicImages(options: CheckOptions, root: string, { publicPaths }: ServedProject): Promise<CheckDiagnostic[]> {
  const level = lintLevel('large-public-image', options.lints)

  if (level === 'allow')
    return []

  const rasters = publicPaths.filter(file => RASTER.test(file.url))
  const sizes = new Map<string, number>()

  // A file that vanished between the scan and now has nothing to report.
  await Promise.all(rasters.map(async (file) => {
    try {
      sizes.set(decoded(file.url), (await stat(file.path)).size)
    }
    catch {}
  }))

  const large = new Map([...sizes].filter(([, size]) => size > LARGE_IMAGE_BYTES))

  if (large.size === 0)
    return []

  const found: CheckDiagnostic[] = []
  const base = (options.base ?? '').replace(TRAILING_SLASHES, '')
  const bySrc = (url: string) => large.get(decoded(url)) ?? (base !== '' && url.startsWith(`${base}/`) ? large.get(decoded(url.slice(base.length))) : undefined)

  const report = (file: string, source: string, start: number, end: number, url: string, size: number) => found.push({
    file,
    ...positionAt(source, start),
    end,
    message: `\`${url}\` is ${Math.round(size / 1024)} KiB and public files are sent as they are, so every visitor downloads it whole`,
    help: 'move it into `src/` and import it, `import hero from \'./hero.jpg\'` then `img(src={hero})`, so kay serves it resized as WebP at the width the page shows it',
    code: 'large-public-image',
    severity: level === 'warn' ? 'warning' : 'error',
  })

  // The files that name a raster outside an `img`: a CSS `url()` in a stylesheet, a `style` block or attribute, and a Markdown image.
  const scanText = (file: string, source: string, pattern: RegExp, shown = source) => {
    for (const match of source.matchAll(pattern)) {
      const url = (match.slice(1).find(group => group !== undefined) ?? '').replace(QUERY_OR_HASH, '')
      const size = bySrc(url)

      if (size !== undefined)
        report(file, shown, match.index, match.index + match[0].length, url, size)
    }
  }

  for (const file of await findKayFiles(root, { project: true, ownKayOnly: true })) {
    const source = await Bun.file(file).text()

    if (URL_CALL.test(source))
      scanText(file, blank(source, CSS_COMMENT), CSS_URL, source)

    if (!source.includes('img') && !source.includes('image'))
      continue

    walkNodes(parseKay(source).template, undefined, (node) => {
      if (node.kind !== 'element' || node.component || (node.name !== 'img' && node.name !== 'meta'))
        return undefined

      const named = (name: string) => node.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === name)
      const staticText = (attribute: NamedAttribute | undefined) => attribute?.kind === 'static' ? attribute.text : undefined

      // A social card names its picture in a `meta`, which every crawler downloads whole.
      const isCard = node.name === 'meta' && SOCIAL_IMAGE.test(staticText(named('property')) ?? staticText(named('name')) ?? '')

      if (node.name === 'meta' && !isCard)
        return undefined

      const src = named(isCard ? 'content' : 'src')
      const url = staticText(src)?.replace(QUERY_OR_HASH, '')
      const size = url === undefined ? undefined : bySrc(url)

      if (src === undefined || url === undefined || size === undefined || (!isCard && named('srcset')))
        return undefined

      report(file, source, src.name.start, src.name.end, url, size)

      return undefined
    })
  }

  for (const file of await findProjectFiles(root, STYLE_OR_MARKDOWN, { project: true, ownKayOnly: true })) {
    const source = await Bun.file(file).text()

    scanText(file, file.endsWith('.css') ? blank(source, CSS_COMMENT) : blank(source, MARKDOWN_CODE), file.endsWith('.css') ? CSS_URL : MARKDOWN_IMAGE_OR_CSS_URL, source)
  }

  return found
}
