import { Resvg } from '@resvg/resvg-js'
import { KayError } from '../compiler/errors'
import { kayLog } from '../runtime/log'

// The root `svg` tag, read once comments are gone, a `>` inside a quoted value included, and the attributes giving it a size.
const COMMENT = /<!--[\s\S]*?-->/g
const ROOT = /<svg\b(?:"[^"]*"|'[^']*'|[^>"'])*>/i
const TEXT = /<text\b/i
const SIZE_ATTRIBUTE = /\s(width|height|viewBox)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const PERCENT = /%\s*$/
// Without system fonts, which resvg would otherwise load on every call, for seconds: text in an icon draws no glyph.
// Pixels a cover may take, a few times a card's.
const COVER_PIXELS = 8_000_000
const OPTIONS = { font: { loadSystemFonts: false } }

// Draws the SVG at `file` as a square PNG of each size asked for, once it checked the SVG has a square size to draw at; what it draws poorly goes to `warn`, kay's log by default.
export async function svgIcon(file: string, what: string, warn = (message: string) => kayLog('warn', message)): Promise<(size: number) => Uint8Array<ArrayBuffer>> {
  const { svg, parsed } = await parseSvg(file, what, warn, 'favicon-invalid')

  if (parsed.width !== parsed.height)
    throw new KayError('favicon-invalid', `kay: the ${what} ${file} is ${parsed.width}x${parsed.height}; it has to be square`)

  return size => new Uint8Array(new Resvg(svg, { ...OPTIONS, fitTo: { mode: 'width', value: size } }).render().asPng())
}

// The SVG at `file` as a PNG at the smallest size covering `width` by `height`, for the image to cut to that size; refused when its ratio would take more than `COVER_PIXELS` to cover.
export async function svgCover(file: string, what: string, width: number, height: number, warn = (message: string) => kayLog('warn', message)): Promise<Uint8Array<ArrayBuffer>> {
  const { svg, parsed } = await parseSvg(file, what, warn, 'share-card-invalid')
  const scale = Math.max(width / parsed.width, height / parsed.height)
  const across = Math.ceil(parsed.width * scale)

  if (across * Math.ceil(parsed.height * scale) > COVER_PIXELS)
    throw new KayError('share-card-invalid', `kay: the ${what} ${file} is ${parsed.width}x${parsed.height}, which takes over ${COVER_PIXELS} pixels to cover ${width}x${height}; give it a ratio nearer the card's`)

  return new Uint8Array(new Resvg(svg, { ...OPTIONS, fitTo: { mode: 'width', value: across } }).render().asPng())
}

async function parseSvg(file: string, what: string, warn: (message: string) => void, code: 'favicon-invalid' | 'share-card-invalid'): Promise<{ svg: string, parsed: Resvg }> {
  const svg = await readSvg(file, what, code)
  let parsed: Resvg

  try {
    parsed = new Resvg(svg, OPTIONS)
  }
  catch (error) {
    throw new KayError(code, `kay: the ${what} ${file} is not an SVG kay can draw: ${error instanceof Error ? error.message : String(error)}`)
  }

  const markup = svg.replace(COMMENT, '')
  const attributes = new Map([...markup.match(ROOT)?.[0].matchAll(SIZE_ATTRIBUTE) ?? []].map(match => [match[1]!.toLowerCase(), match[2] ?? match[3]!]))
  const sized = (name: string) => attributes.has(name) && !PERCENT.test(attributes.get(name)!)

  if (!attributes.has('viewbox') && !(sized('width') && sized('height')))
    throw new KayError(code, `kay: the ${what} ${file} has no viewBox, nor a width and height, so it has no size to draw at; give its svg tag a viewBox`)

  if (TEXT.test(markup))
    warn(`the ${what} ${file} has text, which kay draws without fonts, so as nothing; turn the text into paths`)

  return { svg, parsed }
}

async function readSvg(file: string, what: string, code: 'favicon-invalid' | 'share-card-invalid'): Promise<string> {
  const source = Bun.file(file)

  if (!await source.exists())
    throw new KayError(code, `kay: no ${what} at ${file}`)

  return source.text()
}
