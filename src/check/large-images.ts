import type { CheckDiagnostic, CheckOptions } from '.'
import type { NamedAttribute } from '../compiler/ast'
import type { ServedProject } from './shadow-types'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { findKayFiles, findProjectFiles } from '../build/files'
import { walkNodes } from '../compiler/ast'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { CONFIG_FILE } from '../config'
import { splitFrontmatter } from '../content/markdown'
import { localizedTexts } from '../runtime/localized'
import { configLocator } from './config-keys'

// Past this a raster is worth resizing: the image route serves the same picture as WebP at the width a page shows it, at most 2560 pixels, and a variant at 1280 pixels is seldom above 150 KiB.
export const LARGE_IMAGE_BYTES = 256 * 1024
const RASTER = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i
const QUERY_OR_HASH = /[?#].*$/
const TRAILING_SLASHES = /\/+$/
const SOCIAL_IMAGE = /^(?:og|twitter):image(?::url)?$/i
const STYLE_OR_MARKDOWN = /\.(?:css|md|mdx)$/i
// A `url()` is matched first so a `/*` inside one (`url(/a/*.jpg)`) does not start a comment.
const CSS_COMMENT_OR_URL = /url\((?:"[^"\n]*"|'[^'\n]*'|[^)\n]*)\)|\/\*[\s\S]*?\*\//gi
const MARKDOWN_STYLE = /<style\b[\s\S]*?<\/style>/gi
const INLINE_CODE = /`[^`\n]*`/g
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const INDENTED = /^(?: {4}|\t)/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/
const NOT_NEWLINE = /[^\n]/g
const CSS_NEEDLE = /url\(|image-set\(/i
const CSS_URL = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')\s]+))\s*\)/gi
const IMAGE_SET = /(?:-webkit-)?image-set\((?:[^()]|\([^)]*\))*\)/gi
const IMAGE_SET_STRING = /(?<!url)[(,]\s*(?:"([^"]+)"|'([^']+)')/g
const MARKDOWN_IMAGE = /!\[([^\]]*)\](?:\[([^\]]*)\])?(?!\()|!\[[^\]]*\]\(\s*<?([^)\s>]+)/g
const MARKDOWN_DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)/gm
const HTML_IMG = /<img\b[^>]*>/gi
const HTML_SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i
const SRCSET = /\bsrcset\s*=/i
const FRONTMATTER_IMAGE = /^image:[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m
const SHARE_HELP = 'move it into `src/` and import it, `import hero from \'./hero.jpg\'` then `img(src={hero})`, so kay serves it resized as WebP at the width the page shows it'

interface Found {
  url: string
  index: number
  length: number
}

// The origin of `site`, which a share image's absolute address starts with.
function originOf(site: string | undefined): string | undefined {
  try {
    return site === undefined ? undefined : new URL(site).origin
  }
  catch {
    return undefined
  }
}

// Code a reader does not load is blanked, keeping every offset.
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, span => span.replaceAll(NOT_NEWLINE, ' '))
}

function blankCssComments(text: string): string {
  return text.replace(CSS_COMMENT_OR_URL, span => span.startsWith('/*') ? span.replaceAll(NOT_NEWLINE, ' ') : span)
}

// The fenced blocks (``` and ~~~), indented code blocks and inline code of a Markdown body. An indented line is code after a blank line or another code line, unless it continues a list item.
function blankMarkdownCode(text: string): string {
  const out: string[] = []
  let fence: string | undefined
  let codeAllowed = true
  let inList = false

  for (const line of text.split('\n')) {
    const blanked = line.replaceAll(NOT_NEWLINE, ' ')

    if (fence !== undefined) {
      out.push(blanked)

      if (line.trimStart().startsWith(fence[0]!.repeat(fence.length)) && line.trim().replaceAll(fence[0]!, '') === '')
        fence = undefined

      continue
    }

    const opening = FENCE_OPEN.exec(line)

    if (opening && !(opening[1]![0] === '`' && line.slice(opening[0].length).includes('`'))) {
      fence = opening[1]
      out.push(blanked)

      continue
    }

    if (line.trim() === '') {
      out.push(line)
      codeAllowed = true

      continue
    }

    if (INDENTED.test(line) && codeAllowed && !inList) {
      out.push(blanked)

      continue
    }

    if (LIST_ITEM.test(line))
      inList = true
    else if (!INDENTED.test(line))
      inList = false

    codeAllowed = false
    out.push(line)
  }

  return blank(out.join('\n'), INLINE_CODE)
}

function* cssUrls(text: string): Generator<Found> {
  for (const match of text.matchAll(CSS_URL))
    yield { url: match.slice(1).find(group => group !== undefined) ?? '', index: match.index, length: match[0].length }

  // A bare string in `image-set()` is a url too.
  for (const set of text.matchAll(IMAGE_SET)) {
    for (const match of set[0].matchAll(IMAGE_SET_STRING))
      yield { url: match[1] ?? match[2] ?? '', index: set.index + match.index, length: match[0].length }
  }
}

function* markdownUrls(text: string): Generator<Found> {
  const definitions = new Map<string, string>()

  for (const match of text.matchAll(MARKDOWN_DEFINITION))
    definitions.set(match[1]!.trim().toLowerCase(), match[2]!)

  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const url = match[3] ?? definitions.get((match[2] === undefined || match[2] === '' ? match[1]! : match[2]).trim().toLowerCase())

    if (url !== undefined)
      yield { url, index: match.index, length: match[0].length }
  }

  // An `img` with its own `srcset` is left alone, as in a template.
  for (const tag of text.matchAll(HTML_IMG)) {
    const src = SRCSET.test(tag[0]) ? undefined : HTML_SRC.exec(tag[0])

    if (src)
      yield { url: src[1] ?? src[2] ?? src[3] ?? '', index: tag.index + src.index, length: src[0].length }
  }

  yield* cssUrls(text)
}

// The `image:` of a Markdown file's frontmatter, which a layout reads for the page's share image.
function* frontmatterImage(source: string): Generator<Found> {
  const { frontmatter } = splitFrontmatter(source)
  const match = frontmatter === undefined ? null : FRONTMATTER_IMAGE.exec(frontmatter)

  if (match)
    yield { url: match[1] ?? match[2] ?? match[3] ?? '', index: source.indexOf(frontmatter!) + match.index, length: match[0].length }
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
  const origin = originOf(options.site)
  const bySrcPath = (url: string) => large.get(decoded(url)) ?? (base !== '' && url.startsWith(`${base}/`) ? large.get(decoded(url.slice(base.length))) : undefined)
  const bySrc = (written: string) => bySrcPath(origin !== undefined && written.startsWith(`${origin}/`) ? written.slice(origin.length) : written)

  const report = (file: string, source: string, start: number, end: number, url: string, size: number) => found.push({
    file,
    ...positionAt(source, start),
    end,
    message: `\`${url}\` is ${Math.round(size / 1024)} KiB and public files are sent as they are, so every visitor downloads it whole`,
    help: SHARE_HELP,
    code: 'large-public-image',
    severity: level === 'warn' ? 'warning' : 'error',
  })

  // The files that name a raster outside an `img`: a CSS `url()` in a stylesheet, a `style` block or attribute, and a Markdown image.
  const scanText = (file: string, urls: Iterable<Found>, shown: string) => {
    for (const { url: written, index, length } of urls) {
      const url = written.replace(QUERY_OR_HASH, '')
      const size = bySrc(url)

      if (size !== undefined)
        report(file, shown, index, index + length, url, size)
    }
  }

  // The site's share image, named in `kay.config.ts`.
  const configFile = join(root, CONFIG_FILE)
  const images = localizedTexts(options.seo?.image)

  if (images.length > 0) {
    let configSource: string | undefined

    try {
      configSource = readFileSync(configFile, 'utf8')
    }
    catch {}

    const place = configLocator(configSource)(['seo', 'image'])

    for (const written of images) {
      const url = written.replace(QUERY_OR_HASH, '')
      const size = bySrc(url)

      if (size !== undefined)
        found.push({ file: configFile, ...place, message: `\`${url}\` is ${Math.round(size / 1024)} KiB and public files are sent as they are, so every visitor downloads it whole`, help: SHARE_HELP, code: 'large-public-image', severity: level === 'warn' ? 'warning' : 'error' })
    }
  }

  for (const file of await findKayFiles(root, { project: true, ownKayOnly: true })) {
    const source = await Bun.file(file).text()

    if (CSS_NEEDLE.test(source))
      scanText(file, cssUrls(blankCssComments(source)), source)

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

    if (file.endsWith('.css')) {
      scanText(file, cssUrls(blankCssComments(source)), source)

      continue
    }

    // The frontmatter is read for its `image` apart from the body.
    const head = source.length - splitFrontmatter(source).body.length
    const text = blankMarkdownCode(source.slice(0, head).replaceAll(NOT_NEWLINE, ' ') + source.slice(head)).replace(MARKDOWN_STYLE, blankCssComments)

    scanText(file, [...frontmatterImage(source), ...markdownUrls(text)], source)
  }

  return found
}
