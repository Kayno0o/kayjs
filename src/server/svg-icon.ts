import { Resvg } from '@resvg/resvg-js'
import { kayLog } from '../runtime/log'

// The root `svg` tag, read once comments are gone, a `>` inside a quoted value included, and the attributes giving it a size.
const COMMENT = /<!--[\s\S]*?-->/g
const ROOT = /<svg\b(?:"[^"]*"|'[^']*'|[^>"'])*>/i
const TEXT = /<text\b/i
const SIZE_ATTRIBUTE = /\s(width|height|viewBox)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const PERCENT = /%\s*$/
// Without system fonts, which resvg would otherwise load on every call, for seconds: text in an icon draws no glyph.
const OPTIONS = { font: { loadSystemFonts: false } }

// Draws the SVG at `file` as a square PNG of each size asked for, once it checked the SVG has a square size to draw at.
export async function svgIcon(file: string, what: string): Promise<(size: number) => Uint8Array<ArrayBuffer>> {
  const svg = await readSvg(file, what)
  let parsed: Resvg

  try {
    parsed = new Resvg(svg, OPTIONS)
  }
  catch (error) {
    throw new Error(`kay: the ${what} ${file} is not an SVG kay can draw: ${error instanceof Error ? error.message : String(error)}`)
  }

  const markup = svg.replace(COMMENT, '')
  const attributes = new Map([...markup.match(ROOT)?.[0].matchAll(SIZE_ATTRIBUTE) ?? []].map(match => [match[1]!.toLowerCase(), match[2] ?? match[3]!]))
  const sized = (name: string) => attributes.has(name) && !PERCENT.test(attributes.get(name)!)

  if (!attributes.has('viewbox') && !(sized('width') && sized('height')))
    throw new Error(`kay: the ${what} ${file} has no viewBox, nor a width and height, so it has no size to draw at; give its svg tag a viewBox`)

  if (parsed.width !== parsed.height)
    throw new Error(`kay: the ${what} ${file} is ${parsed.width}x${parsed.height}; it has to be square`)

  if (TEXT.test(markup))
    kayLog('warn', `the ${what} ${file} has text, which kay draws without fonts, so as nothing; turn the text into paths`)

  return size => new Uint8Array(new Resvg(svg, { ...OPTIONS, fitTo: { mode: 'width', value: size } }).render().asPng())
}

async function readSvg(file: string, what: string): Promise<string> {
  const source = Bun.file(file)

  if (!await source.exists())
    throw new Error(`kay: no ${what} at ${file}`)

  return source.text()
}
