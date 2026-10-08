import type { Face } from './face'
import type { Canvas, Color } from './raster'
import { CARD } from '../runtime/image'
import { decodePng, encodePng } from './crop'
import { fillOutline } from './raster'

// How a card is drawn, from `images.card` and `seo.name`.
export interface CardLook {
  face: Face
  background: Color
  color: Color
  name?: string
  quality: number
}

const PADDING = 80

export const TEXT_WIDTH = CARD.width - 2 * PADDING
const TITLE_SIZES = [76, 68, 60, 52, 46]
const TITLE_LINES = 3
const LINE_HEIGHT = 1.18
const NAME_SIZE = 30
const NAME_GAP = 26
const NAME_OPACITY = 0.8
// An image fades into the background from this far down the card, from FADE_TOP to FADE_BOTTOM of it at the bottom, so the title over it reads.
const FADE_START = 0.25
const FADE_TOP = 0.2
const FADE_BOTTOM = 0.9
const ELLIPSIS = '…'

// The title at the largest size that fits three lines, the last cut short past that, above the site's name, at the bottom left; an image, a PNG already cut to the card, covers it, fading into the background below the text.
export async function drawCard(look: CardLook, title: string, image?: Uint8Array): Promise<Uint8Array> {
  const { face, background, color, name, quality } = look
  const canvas: Canvas = { width: CARD.width, height: CARD.height, pixels: new Uint8Array(CARD.width * CARD.height * 3) }

  if (image)
    paintImage(canvas, image, background)
  else
    fill(canvas, background)

  const { size, lines } = fitTitle(face, title)
  let baseline = CARD.height - PADDING

  if (name !== undefined) {
    drawText(canvas, face, cutToWidth(face, name, NAME_SIZE), NAME_SIZE, baseline, color, NAME_OPACITY)
    baseline -= NAME_SIZE * face.ascender / face.unitsPerEm + NAME_GAP
  }

  for (const line of lines.toReversed()) {
    drawText(canvas, face, line, size, baseline, color)
    baseline -= size * LINE_HEIGHT
  }

  const rowLength = CARD.width * 3
  const png = encodePng({ width: CARD.width, height: CARD.height, depth: 8, colorType: 2, bpp: 3, rows: Array.from({ length: CARD.height }, (_, y) => canvas.pixels.subarray(y * rowLength, (y + 1) * rowLength)), kept: [] })

  return new Bun.Image(png).jpeg({ quality }).bytes()
}

function fill(canvas: Canvas, color: Color): void {
  for (let at = 0; at < canvas.pixels.length; at += 3)
    canvas.pixels.set(color, at)
}

// Each pixel over the background by its alpha, then the background over it by the row's fade.
function paintImage(canvas: Canvas, image: Uint8Array, background: Color): void {
  const png = decodePng(image)

  if (png.depth !== 8 || (png.colorType !== 2 && png.colorType !== 6))
    throw new Error('kay: a card is drawn on an RGB image')

  for (const [y, row] of png.rows.entries()) {
    const position = Math.max(0, (y / canvas.height - FADE_START) / (1 - FADE_START))
    const fade = FADE_TOP + (FADE_BOTTOM - FADE_TOP) * position * position * (3 - 2 * position)

    for (let x = 0; x < png.width; x++) {
      const from = x * png.bpp
      const alpha = png.colorType === 6 ? row[from + 3]! / 255 : 1

      for (let channel = 0; channel < 3; channel++) {
        const painted = background[channel]! + (row[from + channel]! - background[channel]!) * alpha

        canvas.pixels[(y * canvas.width + x) * 3 + channel] = Math.round(painted + (background[channel]! - painted) * fade)
      }
    }
  }
}

export function fitTitle(face: Face, title: string): { size: number, lines: string[] } {
  for (const size of TITLE_SIZES) {
    const lines = wrap(face, title, size)

    if (lines.length <= TITLE_LINES)
      return { size, lines }
  }

  const size = TITLE_SIZES.at(-1)!
  const lines = wrap(face, title, size).slice(0, TITLE_LINES)

  lines.push(cutToWidth(face, `${lines.pop()!}${ELLIPSIS}`, size))

  return { size, lines }
}

// Lines at most the card's text width, broken between words, or inside a word wider than a whole line, such as a URL.
function wrap(face: Face, text: string, size: number): string[] {
  const lines: string[] = []
  let line = ''

  for (const word of text.split(' ')) {
    const joined = line === '' ? word : `${line} ${word}`

    if (textWidth(face, joined, size) <= TEXT_WIDTH) {
      line = joined

      continue
    }

    if (line !== '')
      lines.push(line)

    line = word

    while (textWidth(face, line, size) > TEXT_WIDTH) {
      const characters = [...line]
      let fits = characters.length - 1

      while (fits > 1 && textWidth(face, characters.slice(0, fits).join(''), size) > TEXT_WIDTH)
        fits--

      lines.push(characters.slice(0, fits).join(''))
      line = characters.slice(fits).join('')
    }
  }

  if (line !== '')
    lines.push(line)

  return lines
}

// The text, or as much of it as fits followed by an ellipsis, the face's own or three dots.
function cutToWidth(face: Face, text: string, size: number): string {
  if (textWidth(face, text, size) <= TEXT_WIDTH)
    return text

  const ellipsis = face.glyph(ELLIPSIS.codePointAt(0)!) === 0 ? '...' : ELLIPSIS
  let characters = [...text.endsWith(ELLIPSIS) ? text.slice(0, -1) : text]

  while (characters.length > 0 && textWidth(face, `${characters.join('').trimEnd()}${ellipsis}`, size) > TEXT_WIDTH)
    characters = characters.slice(0, -1)

  return `${characters.join('').trimEnd()}${ellipsis}`
}

export function textWidth(face: Face, text: string, size: number): number {
  let width = 0
  let previous: number | undefined

  for (const character of text) {
    const glyph = face.glyph(character.codePointAt(0)!)

    width += face.advance(glyph) + (previous === undefined ? 0 : face.kerning(previous, glyph))
    previous = glyph
  }

  return width * size / face.unitsPerEm
}

function drawText(canvas: Canvas, face: Face, text: string, size: number, baseline: number, color: Color, opacity = 1): void {
  const scale = size / face.unitsPerEm
  let pen = PADDING
  let previous: number | undefined

  for (const character of text) {
    const glyph = face.glyph(character.codePointAt(0)!)

    if (previous !== undefined)
      pen += face.kerning(previous, glyph) * scale

    fillOutline(canvas, face.outline(glyph), { scale, x: pen, y: baseline }, color, opacity)
    pen += face.advance(glyph) * scale
    previous = glyph
  }
}
