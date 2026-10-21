import type { Elysia } from 'elysia'
import type { CardConfig, KayConfig } from '../config'
import type { Localized } from '../runtime/localized'
import type { CardLook } from './card-draw'
import type { Face } from './face'
import type { FontAssets } from './fonts'
import type { ImageRouteOptions } from './image'
import type { Color } from './raster'
import type { RemoteImages } from './remote'
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { countCache } from '../build/cache'
import { SVG_FILE, writeAtomically } from '../build/files'
import { KayError } from '../compiler/errors'
import { CARD, CARD_ROUTE, IMPORTED, setCardMaker, variantFilesLinked, VARIANTS } from '../runtime/image'
import { localeState } from '../runtime/locale-state'
import { localizedText } from '../runtime/localized'
import { nodeCrypto } from './builtins'
import { drawCard, LOGO_SIZE } from './card-draw'
import { coverImage } from './crop'
import { readFace } from './face'
import { builtAsset, DEFAULT_QUALITY, findSource, VARIANTS_DIR } from './image'
import { drawing, MAX_UPLOAD_PIXELS } from './image-format'
import { revalidated } from './public'
import { requestUrl } from './request-url'
import { decodePath } from './routes'
import { sameText } from './seal'

export interface CardSetup {
  // `.kay/client`, where the key cards are signed with is kept.
  dir: string
  // The built client, where the font files are.
  clientDir: string
  // The fonts kay.config.ts lists, as the head declares them.
  fonts: FontAssets | undefined
  config?: CardConfig | undefined
  // `images.card.logo`, absolute.
  logo?: string | undefined
  // The logo `drawLogo` drew before the build started, which the setup takes in place of drawing it again.
  logoDrawn?: Promise<Uint8Array> | undefined
  // `seo.name`, written under the title, in the page's locale when it holds one text per locale.
  name?: Localized | undefined
  // The locale a page outside any locale reads the name in.
  defaultLocale?: string | undefined
  quality?: number | undefined
  // An executable, which only reads what its build wrote.
  bundled?: boolean | undefined
  // A server on a build, which reads the logo the build drew, so a resvg or Bun.Image of its own still finds the cards prerendered under their names.
  prebuilt?: boolean | undefined
  // Keeps the cards pages ask for, for `kay build` to write: on while prerendering.
  collect?: boolean | undefined
}

// What one setup draws and signs cards with. The face is read on the first card drawn and the key made on the first card linked, so an app drawing none reads and writes nothing for them.
export interface Cards {
  font: { family: string, path: string } | Error
  face?: Promise<Face> | undefined
  key: Uint8Array | undefined
  dir: string
  bundled: boolean
  prebuilt: boolean
  // The built client, where the imported SVGs cards are drawn on live.
  clientDir: string
  // Changes with anything that changes how a card looks, so a card's file name and URL change with it.
  look: string
  background: Color
  color: Color
  // The name in the default locale, and every name `seo.name` holds.
  name?: string | undefined
  names?: Localized | undefined
  defaultLocale?: string | undefined
  logo?: Uint8Array | undefined
  quality: number
  collect: boolean
}

const KEY_FILE = 'card.key'
const LOGO_FILE = 'card-logo.png'
const SVG_DRAWING = /^card-svg-.+\.png$/
const QUERY = /\?.*$/
const COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i
const SPACES = /\s+/g
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
const NOSNIFF = { 'x-content-type-options': 'nosniff' }
const IMMUTABLE = 'public, max-age=31536000, immutable'
// Raised whenever the way a card is drawn changes, which renames every card.
const DRAWING = 1
const DEFAULT_WEIGHT = 700
// Past this many characters a title is cut before it is signed: three lines of the smallest size hold far fewer.
const MAX_TITLE = 200
const REMOTE = /^https?:\/\//i

// The setup pages link cards with, and the cards prerendered pages asked for, by file name, for `kay build` to write.
let current: Cards | undefined
const svgDrawings = new Map<string, Promise<Uint8Array>>()
const requested = new Map<string, { title: string, image?: string | undefined, name?: string | undefined }>()

// What `images.card` refuses that needs no build: a colour that is none, a face the explicit `fonts` lack (a Fontsource family's faces are known once built).
export function checkCardConfig(config: CardConfig | undefined, fonts: KayConfig['fonts']): void {
  if (config === undefined)
    return

  cardColor('background', config.background ?? '#111111')
  cardColor('color', config.color ?? '#ffffff')

  const listed = fonts ?? []
  const explicit = listed.filter(font => 'src' in font)

  if (config.font !== undefined && explicit.length === listed.length) {
    const faces = explicit.map(font => ({ family: font.family, weight: String(font.weight ?? 400), style: font.style ?? 'normal', url: `${ASSET_PREFIX}face` }))
    const font = cardFont('', faces, config.font)

    if (font instanceof Error)
      throw font
  }
}

// Settles the face, look and key cards are drawn and signed with, for every card this process links, served or prerendered; a face `images.card.font` names that `fonts` lacks stops the boot.
export async function setupCards(setup: CardSetup): Promise<Cards> {
  const font = cardFont(setup.clientDir, setup.fonts?.faces, setup.config?.font)

  if (font instanceof Error && setup.config?.font !== undefined)
    throw font

  const background = cardColor('background', setup.config?.background ?? '#111111')
  const color = cardColor('color', setup.config?.color ?? '#ffffff')
  const quality = setup.quality ?? DEFAULT_QUALITY
  const logo = await cardLogo(setup)
  const keyFile = Bun.file(join(setup.dir, KEY_FILE))
  const cards: Cards = {
    font,
    key: await keyFile.exists() ? await keyFile.bytes() : undefined,
    dir: setup.dir,
    bundled: setup.bundled ?? false,
    prebuilt: setup.prebuilt ?? false,
    clientDir: setup.clientDir,
    // The other locales' names are part of each card's spec, so a change to one renames its cards alone.
    look: Bun.hash(JSON.stringify([DRAWING, font instanceof Error ? '' : font.path, background, color, localizedText(setup.name, setup.defaultLocale, setup.defaultLocale) ?? '', quality, ...logo === undefined ? [] : [Bun.hash(logo).toString(36)]])).toString(36),
    background,
    color,
    name: localizedText(setup.name, setup.defaultLocale, setup.defaultLocale),
    names: setup.name,
    defaultLocale: setup.defaultLocale,
    logo,
    quality,
    collect: setup.collect ?? false,
  }

  if (cards.collect) {
    requested.clear()
    svgDrawings.clear()
    // An executable carries the key its build made, whether or not a prerendered page linked a card.
    signingKey(cards)
  }

  current = cards
  setCardMaker((title, image) => cardUrl(cards, title, image))

  return cards
}

// The upright face of the family asked for, or the first one listed, at the weight nearest the one asked for.
function cardFont(clientDir: string, faces: FontAssets['faces'], wanted: CardConfig['font']): Cards['font'] {
  if (!faces || faces.length === 0)
    return new KayError('share-card-invalid', 'kay: shareCard() draws the title in a face of `fonts` in kay.config.ts, which lists none')

  const family = wanted?.family ?? faces[0]!.family
  const weight = wanted?.weight ?? DEFAULT_WEIGHT
  const distance = (face: { weight: string }) => {
    const [low, high = low] = face.weight.split(' ').map(Number) as [number, number?]

    if (weight < low)
      return low - weight

    return weight > high ? weight - high : 0
  }
  const chosen = faces.filter(face => face.family === family && face.style === 'normal').toSorted((a, b) => distance(a) - distance(b))[0]

  if (!chosen)
    return new KayError('share-card-invalid', `kay: images.card.font names ${family}, of which \`fonts\` in kay.config.ts lists no upright face`)

  return { family, path: join(clientDir, decodeURIComponent(chosen.url.slice(ASSET_PREFIX.length))) }
}

// The imported SVG a card is drawn on, never a file outside the built assets.
function svgFile(cards: Cards, image: string): string | undefined {
  return builtAsset(cards.clientDir, decodePath(image.slice(IMPORTED.length).replace(QUERY, '')))
}

function svgDrawingName(image: string): string {
  return `card-svg-${Bun.hash(image.replace(QUERY, '')).toString(36)}.png`
}

function isSvgCard(image: string | undefined): image is string {
  return image !== undefined && image.startsWith(IMPORTED) && SVG_FILE.test(image.replace(QUERY, ''))
}

// An imported SVG rasterized to cover the card. A build keeps that drawing beside the key, as an executable carries no SVG drawer and reads it instead; the name holds the SVG's content, so a changed SVG is drawn again and renames its cards.
async function cardSvg(cards: Cards, image: string): Promise<Uint8Array> {
  const built = join(cards.dir, svgDrawingName(image))

  if ((cards.bundled || cards.prebuilt) && await Bun.file(built).exists())
    return Bun.file(built).bytes()

  if (cards.bundled)
    throw new KayError('executable-incomplete', `kay: this executable holds no drawing of ${image} for a share card; build it again with kay build --compile`)

  const file = svgFile(cards, image)

  if (file === undefined || !await Bun.file(file).exists())
    throw new KayError('share-card-invalid', `kay: shareCard() was given ${image}, which the build holds no file of`)

  if (!cards.collect) {
    // Imported here alone, as an executable leaves the module out.
    const { svgCover } = await import('./svg-icon')

    return svgCover(file, 'shareCard() image', CARD.width, CARD.height)
  }

  // A build draws each SVG once, whatever the drawing an earlier build kept.
  let drawing = svgDrawings.get(built)

  if (!drawing) {
    drawing = (async () => {
      try {
        const { svgCover } = await import('./svg-icon')
        const raster = await svgCover(file, 'shareCard() image', CARD.width, CARD.height)

        await writeAtomically(built, raster)

        return raster
      }
      catch (error) {
        svgDrawings.delete(built)

        throw error
      }
    })()
    svgDrawings.set(built, drawing)
  }

  return drawing
}

// The logo drawn at the size a card shows it. A build keeps that drawing beside the key, as an executable carries no SVG drawer and reads it instead, as does a server on that build, and drops one the config no longer names.
async function cardLogo(setup: CardSetup): Promise<Uint8Array | undefined> {
  const built = join(setup.dir, LOGO_FILE)

  if (setup.logo === undefined) {
    if (setup.collect)
      await rm(built, { force: true })

    return undefined
  }

  if (setup.bundled) {
    if (!await Bun.file(built).exists())
      throw new KayError('executable-incomplete', 'kay: this executable holds no drawing of images.card.logo; build it again with kay build --compile')

    return Bun.file(built).bytes()
  }

  if (setup.prebuilt && !setup.collect && await Bun.file(built).exists())
    return Bun.file(built).bytes()

  const logo = await (setup.logoDrawn ?? drawLogo(setup.logo))

  if (setup.collect)
    await Bun.write(built, logo)

  return logo
}

// What `kay check` reports of `images.card.logo`, as the boot would refuse it, and a warning for an SVG with text.
export async function cardLogoProblems(file: string): Promise<{ file: string, message: string, severity?: 'warning' }[]> {
  const warnings: string[] = []

  try {
    await drawLogo(file, message => warnings.push(message))
  }
  catch (error) {
    return [{ file, message: error instanceof Error ? error.message : String(error) }]
  }

  return warnings.map(message => ({ file, message: `kay: ${message}`, severity: 'warning' as const }))
}

export async function drawLogo(file: string, warn?: (message: string) => void): Promise<Uint8Array> {
  if (!await Bun.file(file).exists())
    throw new KayError('share-card-invalid', `kay: images.card.logo names ${file}, which does not exist`)

  if (SVG_FILE.test(file)) {
    // Imported here alone, as an executable leaves the module out.
    const { svgIcon } = await import('./svg-icon')

    return (await svgIcon(file, 'images.card.logo', warn))(LOGO_SIZE)
  }

  let size: { width: number, height: number }

  try {
    size = await new Bun.Image(file).metadata()

    if (size.width === size.height)
      return await new Bun.Image(file).resize(LOGO_SIZE, LOGO_SIZE).png().bytes()
  }
  catch {
    throw new KayError('share-card-invalid', `kay: images.card.logo names ${file}, which is no SVG, PNG, JPEG or WebP kay can draw`)
  }

  throw new KayError('share-card-invalid', `kay: images.card.logo, ${file}, is ${size.width}x${size.height}; it has to be square`)
}

function cardColor(setting: string, value: string): Color {
  if (!COLOR.test(value))
    throw new KayError('share-card-invalid', `kay: images.card.${setting} is ${value}, which is no #rrggbb colour`)

  const hex = value.length === 4 ? [...value.slice(1)].map(digit => digit + digit).join('') : value.slice(1)

  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)]
}

async function cardFace(cards: Cards): Promise<Face> {
  const { font } = cards

  if (font instanceof Error)
    throw font

  cards.face ??= (async () => {
    try {
      return readFace(await Bun.file(font.path).bytes())
    }
    catch (error) {
      throw new KayError('share-card-invalid', `kay: shareCard() cannot draw in ${font.family}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()

  return cards.face
}

// A key of the build's own, kept beside the client build and never served, so a card URL cannot be made up with any title.
function signingKey(cards: Cards): Uint8Array {
  cards.key ??= existingKey(cards)

  if (cards.key)
    return cards.key

  if (cards.bundled)
    throw new KayError('executable-incomplete', 'kay: this executable holds no key to sign share cards with; build it again with kay build --compile')

  // Written under a name of its own and linked into place, so another process starting from the same project reads either no key or the whole of the one that won.
  const file = join(cards.dir, KEY_FILE)
  const partial = `${file}.${crypto.randomUUID()}.tmp`

  mkdirSync(cards.dir, { recursive: true })
  writeFileSync(partial, nodeCrypto().randomBytes(32), { mode: 0o600 })

  try {
    linkSync(partial, file)
  }
  catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST')
      throw error
  }
  finally {
    rmSync(partial, { force: true })
  }

  cards.key = new Uint8Array(readFileSync(file))

  return cards.key
}

// The key another process of the project may have made since this one started.
function existingKey(cards: Cards): Uint8Array | undefined {
  const file = join(cards.dir, KEY_FILE)

  return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined
}

function cardUrl(cards: Cards, title: unknown, image: string | undefined): string {
  if (cards.font instanceof Error)
    throw cards.font

  if (typeof title !== 'string')
    throw new KayError('share-card-invalid', `kay: shareCard() takes its title as a string, and was given ${title === null ? 'null' : typeof title}`)

  const text = cardTitle(title)

  if (text === '')
    throw new KayError('share-card-invalid', 'kay: shareCard() was given an empty title')

  const name = nameFor(cards)
  const spec = cardSpec(text, image, name)
  const linked = variantFilesLinked()

  // A static export downloads a remote image to draw its card; a server draws it on request, from the copy the image route keeps fresh.
  if (image !== undefined && !image.startsWith(IMPORTED) && !(linked && REMOTE.test(image))) {
    if (linked)
      throw new KayError('share-card-invalid', `kay: shareCard() was given ${image}, which a static export holds no file of: only the card of an imported image, or one images.remote lists, is written at build`)
  }
  else if (cards.collect) {
    requested.set(cardFile(cards, spec), { title: text, image, name })
  }

  if (linked)
    return `${VARIANTS}${cardFile(cards, spec)}`

  return `${CARD_ROUTE}?${new URLSearchParams({ title: text, ...(image === undefined ? {} : { src: image }), ...(name === undefined ? {} : { name }), v: cards.look, sig: signature(signingKey(cards), spec) })}`
}

function cardTitle(title: string): string {
  return [...title.normalize('NFC').replace(SPACES, ' ').trim()].slice(0, MAX_TITLE).join('')
}

// The name a page of another locale reads in place of the default locale's, undefined while it reads the same, so those cards and their URLs are the default locale's.
function nameFor(cards: Cards): string | undefined {
  const name = localizedText(cards.names, localeState()?.locale, cards.defaultLocale)

  return name === cards.name ? undefined : name
}

// A name of its own is part of what is signed, so it cannot be made up either.
function cardSpec(title: string, image: string | undefined, name?: string): string {
  return JSON.stringify(name === undefined ? [title, image ?? ''] : [title, image ?? '', name])
}

// `version` tells apart the cards of an image from `images.dirs`, which may change in place.
function cardFile(cards: Cards, spec: string, version = ''): string {
  return `card-${Bun.hash(`${spec}\n${cards.look}${version}`).toString(36)}.jpg`
}

function signature(key: Uint8Array, spec: string): string {
  return nodeCrypto().createHmac('sha256', key).update(spec).digest('base64url').slice(0, 22)
}

function signed(key: Uint8Array, spec: string, given: string): boolean {
  return sameText(given, signature(key, spec))
}

// `/_kay/card?title=...&src=...&sig=...` answers the JPEG card a page linked, drawn on its first request and kept in the cache directory; a title or image the server did not sign is not found.
export function serveCards(app: Elysia, cards: Cards, options: ImageRouteOptions): void {
  const pending = new Map<string, Promise<void>>()

  app.get(CARD_ROUTE, async ({ request }) => {
    const url = requestUrl(request)
    const title = url.searchParams.get('title') ?? ''
    const src = url.searchParams.get('src') ?? undefined
    const siteName = url.searchParams.get('name') ?? undefined
    const spec = cardSpec(title, src, siteName)
    const key = cards.key ??= existingKey(cards)

    if (!key || cards.font instanceof Error || !signed(key, spec, url.searchParams.get('sig') ?? ''))
      return new Response('Not Found', { status: 404, headers: TEXT })

    const svg = isSvgCard(src)
    const source = src === undefined || svg ? undefined : await findSource(src, options)
    let version = ''

    if (source && 'status' in source)
      return new Response(source.message, { status: source.status, headers: TEXT })

    if (svg && svgFile(cards, src) === undefined)
      return new Response('Not Found', { status: 404, headers: TEXT })

    if (src !== undefined && !svg) {
      if (!source)
        return new Response('Not Found', { status: 404, headers: TEXT })

      try {
        const stats = await stat(source.path)

        if (!source.immutable)
          version = `\n${stats.size}\n${stats.mtimeMs}`
      }
      catch {
        return new Response('Not Found', { status: 404, headers: TEXT })
      }
    }

    // A stored or remote image's card starts with the prefix its variants do, so deleting the original drops the card.
    const name = `${source?.prefix ?? ''}${cardFile(cards, spec, version)}`
    const built = join(options.clientDir, VARIANTS_DIR, name)
    const file = await Bun.file(built).exists() ? built : join(options.cacheDir, name)

    if (file !== built && !await Bun.file(file).exists()) {
      let writing = pending.get(file)

      // Requests for a card being drawn wait for that one drawing.
      if (!writing) {
        writing = (async () => {
          try {
            await drawing(async () => writeCard(cards, file, title, siteName, svg ? { input: await cardSvg(cards, src) } : source && { input: Bun.file(source.path), maxPixels: source.immutable ? undefined : MAX_UPLOAD_PIXELS }))
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
      catch (error) {
        const code = (error as { code?: string }).code

        if (code === 'ERR_IMAGE_TOO_MANY_PIXELS')
          return new Response(`Image over ${MAX_UPLOAD_PIXELS} pixels`, { status: 413, headers: TEXT })

        if (code?.startsWith('ERR_IMAGE_'))
          return new Response('Not an image kay can draw a card on', { status: 415, headers: TEXT })

        throw error
      }
    }

    // A URL from before the look changed still answers, with the card as it looks now, which may change again.
    if (url.searchParams.get('v') === cards.look && (!source || source.immutable))
      return new Response(Bun.file(file), { headers: { 'cache-control': IMMUTABLE, ...NOSNIFF } })

    return revalidated(request, `W/"${name}"`, () => Bun.file(file), NOSNIFF)
  })
}

// The cards prerendered pages asked for, written beside the image variants for the route or a static host to serve as files; returns how many were drawn. A card an earlier build drew is copied from the cache, which keeps only this build's.
export async function writeCards(clientDir: string, cacheDir?: string, remote?: RemoteImages): Promise<number> {
  let drawn = 0

  for (const [name, card] of requested) {
    const target = join(clientDir, VARIANTS_DIR, name)

    // An executable draws no SVG, so the build keeps the drawing of each one a card is on, whether or not that card is drawn again.
    if (isSvgCard(card.image))
      await cardSvg(current!, card.image)

    const cached = cacheDir !== undefined && cacheDir !== '' ? join(cacheDir, name) : undefined

    if (await Bun.file(target).exists())
      continue

    const kept = cached !== undefined && await Bun.file(cached).exists()

    countCache('share cards', kept)

    if (!kept) {
      const svg = isSvgCard(card.image)
      const source = card.image === undefined || svg ? undefined : await findSource(card.image, { clientDir, cacheDir: '', remote })

      if (source && 'status' in source)
        throw new KayError('share-card-invalid', `kay: a page's share card is drawn on ${card.image}, which the build could not download: ${source.message}`)

      await writeCard(current!, cached ?? target, card.title, card.name, svg ? { input: await cardSvg(current!, card.image!) } : source && { input: Bun.file(source.path), maxPixels: source.immutable ? undefined : MAX_UPLOAD_PIXELS })
      drawn++
    }

    if (cached !== undefined)
      await Bun.write(target, Bun.file(cached))
  }

  if (cacheDir !== undefined && cacheDir !== '' && existsSync(cacheDir))
    await Promise.all((await readdir(cacheDir)).filter(name => !requested.has(name)).map(async name => rm(join(cacheDir, name), { force: true })))

  if (current?.collect) {
    const kept = new Set([...requested.values()].filter(card => isSvgCard(card.image)).map(card => svgDrawingName(card.image!)))

    await Promise.all((await readdir(current.dir)).filter(name => SVG_DRAWING.test(name) && !kept.has(name)).map(async name => rm(join(current!.dir, name), { force: true })))
  }

  return drawn
}

async function writeCard(cards: Cards, target: string, title: string, name: string | undefined, image?: { input: Blob | Uint8Array, maxPixels?: number | undefined }): Promise<void> {
  const look: CardLook = { face: await cardFace(cards), background: cards.background, color: cards.color, name: name ?? cards.name, logo: cards.logo, quality: cards.quality }

  await writeAtomically(target, await drawCard(look, title, image && await coverImage(image.input, CARD.width, CARD.height, image.maxPixels)))
}
