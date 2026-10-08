import type { Elysia } from 'elysia'
import type { CardConfig } from '../config'
import type { Face } from './face'
import type { FontAssets } from './fonts'
import type { ImageRouteOptions } from './image'
import type { Canvas, Color } from './raster'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { CARD, CARD_ROUTE, IMPORTED, setCardMaker, variantFilesLinked, VARIANTS } from '../runtime/image'
import { coverImage, decodePng, encodePng } from './crop'
import { readFace } from './face'
import { builtFonts } from './fonts'
import { MAX_UPLOAD_PIXELS, sourceFile, VARIANTS_DIR } from './image'
import { revalidated } from './public'
import { blend, fillOutline } from './raster'

export interface CardSetup {
  // `.kay/client`, where the build records its fonts and the key cards are signed with.
  dir: string
  // The built client, where the font files are.
  clientDir: string
  // Whether kay.config.ts lists fonts: a `fonts.json` left from an earlier build is not read otherwise.
  fonts: boolean
  config?: CardConfig
  // `seo.name`, written under the title.
  name?: string
  quality?: number
  // An executable, which only reads what its build wrote.
  bundled?: boolean
  // Keeps the cards pages ask for, for `kay build` to write: on while prerendering.
  collect?: boolean
}

interface Cards {
  face: Face | Error
  key: Uint8Array | undefined
  // Changes with anything that changes how a card looks, so a card's file name and URL change with it.
  look: string
  background: Color
  color: Color
  name?: string
  quality: number
  collect: boolean
}

const KEY_FILE = 'card.key'
const COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i
const SPACES = /\s+/g
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
const IMMUTABLE = 'public, max-age=31536000, immutable'
// Raised whenever the way a card is drawn changes, which renames every card.
const DRAWING = 1
const DEFAULT_WEIGHT = 700
// Past this many characters a title is cut before it is signed: three lines of the smallest size hold far fewer.
const MAX_TITLE = 200
const PADDING = 80
const TITLE_SIZES = [76, 68, 60, 52, 46]
const TITLE_LINES = 3
const LINE_HEIGHT = 1.18
const NAME_SIZE = 30
const NAME_GAP = 26
const NAME_OPACITY = 0.8
// How much an image fades into the background, at its top and at its bottom, so the title over it reads.
const FADE_TOP = 0.2
const FADE_BOTTOM = 0.9

let cards: Cards | undefined
// The cards prerendered pages asked for, by file name, for `kay build` to write.
const requested = new Map<string, { title: string, image?: string }>()

// Reads the face cards are drawn in and the key their URLs are signed with, for every card this process draws, served or prerendered. A face that cannot be read only fails a page asking for a card, unless `images.card.font` named it.
export async function setupCards(setup: CardSetup): Promise<void> {
  const fonts = setup.fonts ? await builtFonts(setup.dir) : undefined
  const loaded = await cardFace(setup.clientDir, fonts?.faces, setup.config?.font)

  if (loaded instanceof Error && setup.config?.font !== undefined)
    throw loaded

  const background = cardColor('background', setup.config?.background ?? '#111111')
  const color = cardColor('color', setup.config?.color ?? '#ffffff')
  const quality = setup.quality ?? 80

  if (setup.collect)
    requested.clear()

  cards = {
    face: loaded instanceof Error ? loaded : loaded.face,
    key: await cardKey(setup.dir, setup.bundled ?? false),
    look: Bun.hash(JSON.stringify([DRAWING, loaded instanceof Error ? '' : loaded.url, background, color, setup.name ?? '', quality])).toString(36),
    background,
    color,
    name: setup.name,
    quality,
    collect: setup.collect ?? false,
  }
  setCardMaker(cardUrl)
}

// The upright face of the family asked for, or the first one listed, at the weight nearest the one asked for.
async function cardFace(clientDir: string, faces: FontAssets['faces'], wanted: CardConfig['font']): Promise<{ face: Face, url: string } | Error> {
  if (!faces || faces.length === 0)
    return new Error('kay: shareCard() draws the title in a face of `fonts` in kay.config.ts, which lists none')

  const family = wanted?.family ?? faces[0]!.family
  const weight = wanted?.weight ?? DEFAULT_WEIGHT
  const upright = faces.filter(face => face.family === family && face.style === 'normal')
  const distance = (face: { weight: string }) => {
    const [low, high = low] = face.weight.split(' ').map(Number) as [number, number?]

    return weight < low ? low - weight : weight > high ? weight - high : 0
  }
  const chosen = upright.toSorted((a, b) => distance(a) - distance(b))[0]

  if (!chosen)
    return new Error(`kay: images.card.font names ${family}, of which \`fonts\` in kay.config.ts lists no upright face`)

  try {
    return { face: readFace(await Bun.file(join(clientDir, chosen.url.slice(ASSET_PREFIX.length))).bytes()), url: chosen.url }
  }
  catch (error) {
    return new Error(`kay: shareCard() cannot draw in ${family}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function cardColor(setting: string, value: string): Color {
  if (!COLOR.test(value))
    throw new Error(`kay: images.card.${setting} is ${value}, which is no #rrggbb colour`)

  const hex = value.length === 4 ? [...value.slice(1)].map(digit => digit + digit).join('') : value.slice(1)

  return [0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) as unknown as Color
}

// A key of the build's own, kept beside the client build and never served, so a card URL cannot be made up with any title.
async function cardKey(dir: string, bundled: boolean): Promise<Uint8Array | undefined> {
  const file = Bun.file(join(dir, KEY_FILE))

  if (await file.exists())
    return file.bytes()

  if (bundled)
    return undefined

  await mkdir(dir, { recursive: true })

  // Another process starting from the same project may write it first: both then read the one that won.
  try {
    await writeFile(join(dir, KEY_FILE), randomBytes(32), { flag: 'wx' })
  }
  catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST')
      throw error
  }

  return Bun.file(join(dir, KEY_FILE)).bytes()
}

function cardUrl(title: string, image: string | undefined): string {
  if (!cards)
    throw new Error('kay: shareCard() draws on the server, in a page\'s head')

  if (cards.face instanceof Error)
    throw cards.face

  if (!cards.key)
    throw new Error('kay: this executable holds no key to sign share cards with; build it again with kay build --compile')

  const text = cardTitle(title)

  if (text === '')
    throw new Error('kay: shareCard() was given an empty title')

  const spec = cardSpec(text, image)
  const linked = variantFilesLinked()

  if (image !== undefined && !image.startsWith(IMPORTED)) {
    if (linked)
      throw new Error(`kay: shareCard() was given ${image}, which a static export holds no file of: only an imported image's card is written at build`)
  }
  else if (cards.collect) {
    requested.set(cardFile(spec), { title: text, image })
  }

  if (linked)
    return `${VARIANTS}${cardFile(spec)}`

  return `${CARD_ROUTE}?${new URLSearchParams({ title: text, ...(image === undefined ? {} : { src: image }), v: cards.look, sig: signature(cards.key, spec) })}`
}

function cardTitle(title: string): string {
  return [...title.normalize('NFC').replace(SPACES, ' ').trim()].slice(0, MAX_TITLE).join('')
}

function cardSpec(title: string, image: string | undefined): string {
  return JSON.stringify([title, image ?? ''])
}

// `version` tells apart the cards of an image from `images.dirs`, which may change in place.
function cardFile(spec: string, version = ''): string {
  return `card-${Bun.hash(`${spec}\n${cards!.look}${version}`).toString(36)}.jpg`
}

function signature(key: Uint8Array, spec: string): string {
  return createHmac('sha256', key).update(spec).digest('base64url').slice(0, 22)
}

function signed(key: Uint8Array, spec: string, given: string): boolean {
  const expected = Buffer.from(signature(key, spec))
  const actual = Buffer.from(given)

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// `/_kay/card?title=...&src=...&sig=...` answers the JPEG card a page linked, drawn on its first request and kept in the cache directory; a title or image the server did not sign is not found.
export function serveCards(app: Elysia, options: ImageRouteOptions): void {
  const pending = new Map<string, Promise<void>>()

  app.get(CARD_ROUTE, async ({ request }) => {
    const url = new URL(request.url)
    const title = url.searchParams.get('title') ?? ''
    const src = url.searchParams.get('src') ?? undefined
    const spec = cardSpec(title, src)

    if (!cards?.key || cards.face instanceof Error || !signed(cards.key, spec, url.searchParams.get('sig') ?? ''))
      return new Response('Not found', { status: 404, headers: TEXT })

    const source = src === undefined ? undefined : sourceFile(src, options)
    let version = ''

    if (src !== undefined) {
      if (!source)
        return new Response('Not found', { status: 404, headers: TEXT })

      try {
        const stats = await stat(source.path)

        if (!source.immutable)
          version = `\n${stats.size}\n${stats.mtimeMs}`
      }
      catch {
        return new Response('Not found', { status: 404, headers: TEXT })
      }
    }

    const name = cardFile(spec, version)
    const built = join(options.clientDir, VARIANTS_DIR, name)
    const file = await Bun.file(built).exists() ? built : join(options.cacheDir, name)

    if (file !== built && !await Bun.file(file).exists()) {
      let writing = pending.get(file)

      // Requests for a card being drawn wait for that one drawing.
      if (!writing) {
        writing = (async () => {
          try {
            await writeCard(file, title, source && { path: source.path, maxPixels: source.immutable ? undefined : MAX_UPLOAD_PIXELS })
          }
          finally {
            pending.delete(file)
          }
        })()
        pending.set(file, writing)
      }

      try {
        await writing
      }
      catch {
        return new Response('Not an image kay can draw a card on', { status: 415, headers: TEXT })
      }
    }

    // A URL from before the look changed still answers, with the card as it looks now, which may change again.
    if (url.searchParams.get('v') === cards.look && (!source || source.immutable))
      return new Response(Bun.file(file), { headers: { 'cache-control': IMMUTABLE } })

    return revalidated(request, `W/"${name}"`, () => Bun.file(file))
  })
}

// The cards prerendered pages asked for, written beside the image variants for the route or a static host to serve as files; returns how many were drawn. A card an earlier build drew is copied from the cache, which keeps only this build's.
export async function writeCards(clientDir: string, cacheDir?: string): Promise<number> {
  let drawn = 0

  for (const [name, card] of requested) {
    const target = join(clientDir, VARIANTS_DIR, name)
    const cached = cacheDir && join(cacheDir, name)

    if (await Bun.file(target).exists())
      continue

    if (!cached || !await Bun.file(cached).exists()) {
      const source = card.image === undefined ? undefined : sourceFile(card.image, { clientDir, cacheDir: '' })

      await writeCard(cached || target, card.title, source && { path: source.path })
      drawn++
    }

    if (cached)
      await Bun.write(target, Bun.file(cached))
  }

  if (cacheDir && existsSync(cacheDir))
    await Promise.all((await readdir(cacheDir)).filter(name => !requested.has(name)).map(async name => rm(join(cacheDir, name), { force: true })))

  return drawn
}

// Written under a temporary name and moved into place, so a reader never sees a card half written.
async function writeCard(target: string, title: string, image?: { path: string, maxPixels?: number }): Promise<void> {
  const partial = `${target}.${crypto.randomUUID()}.tmp`

  await Bun.write(partial, await drawCard(title, image && await coverImage(Bun.file(image.path), CARD.width, CARD.height, image.maxPixels)))
  await rename(partial, target)
}

// The title at the largest size that fits three lines, the last cut short past that, above the site's name, at the bottom left; an image covers the card, fading into the background below the text.
export async function drawCard(title: string, image?: Uint8Array): Promise<Uint8Array> {
  const { face, background, color, name, quality } = cards!

  if (face instanceof Error)
    throw face

  const canvas: Canvas = { width: CARD.width, height: CARD.height, pixels: new Uint8Array(CARD.width * CARD.height * 3) }

  if (image)
    paintImage(canvas, image, background)
  else
    fill(canvas, background)

  const width = CARD.width - 2 * PADDING
  const { size, lines } = fitTitle(face, title, width)
  let baseline = CARD.height - PADDING

  if (name !== undefined) {
    drawText(canvas, face, cutToWidth(face, name, NAME_SIZE, width), NAME_SIZE, baseline, color, NAME_OPACITY)
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

// An image already cut to the card, its transparent parts over the background, then faded into it toward the bottom.
function paintImage(canvas: Canvas, image: Uint8Array, background: Color): void {
  const png = decodePng(image)

  if (png.depth !== 8 || (png.colorType !== 2 && png.colorType !== 6))
    throw new Error('kay: a card is drawn on an RGB image')

  for (const [y, row] of png.rows.entries()) {
    for (let x = 0; x < png.width; x++) {
      const at = (y * canvas.width + x) * 3
      const pixel = row.subarray(x * png.bpp, x * png.bpp + 3)

      canvas.pixels.set(background, at)
      blend(canvas, at, [pixel[0]!, pixel[1]!, pixel[2]!], png.colorType === 6 ? row[x * png.bpp + 3]! / 255 : 1)
    }

    const position = Math.max(0, (y / canvas.height - 0.25) / 0.75)
    const fade = FADE_TOP + (FADE_BOTTOM - FADE_TOP) * position * position * (3 - 2 * position)

    for (let x = 0; x < canvas.width; x++)
      blend(canvas, (y * canvas.width + x) * 3, background, fade)
  }
}

function fitTitle(face: Face, title: string, width: number): { size: number, lines: string[] } {
  for (const size of TITLE_SIZES) {
    const lines = wrap(face, title, size, width)

    if (lines.length <= TITLE_LINES)
      return { size, lines }
  }

  const size = TITLE_SIZES.at(-1)!
  const lines = wrap(face, title, size, width).slice(0, TITLE_LINES)

  lines.push(cutToWidth(face, `${lines.pop()!}…`, size, width))

  return { size, lines }
}

// Lines at most `width` wide, broken between words, or inside a word wider than a whole line, such as a URL.
function wrap(face: Face, text: string, size: number, width: number): string[] {
  const lines: string[] = []
  let line = ''

  for (const word of text.split(' ')) {
    const joined = line === '' ? word : `${line} ${word}`

    if (textWidth(face, joined, size) <= width) {
      line = joined

      continue
    }

    if (line !== '')
      lines.push(line)

    line = word

    while (textWidth(face, line, size) > width) {
      const characters = [...line]
      let fits = characters.length - 1

      while (fits > 1 && textWidth(face, characters.slice(0, fits).join(''), size) > width)
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
function cutToWidth(face: Face, text: string, size: number, width: number): string {
  if (textWidth(face, text, size) <= width)
    return text

  const ellipsis = face.glyph(0x2026) === 0 ? '...' : '…'
  let characters = [...text.endsWith('…') ? text.slice(0, -1) : text]

  while (characters.length > 0 && textWidth(face, `${characters.join('').trimEnd()}${ellipsis}`, size) > width)
    characters = characters.slice(0, -1)

  return `${characters.join('').trimEnd()}${ellipsis}`
}

function textWidth(face: Face, text: string, size: number): number {
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
