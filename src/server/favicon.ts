import type { Elysia } from 'elysia'
import type { FaviconConfig, ManifestConfig } from '../config'
import type { HeadTag } from '../runtime/head'
import type { Localized } from '../runtime/localized'
import type { ServedPaths } from './served-paths'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SVG_FILE } from '../build/files'
import { KayError } from '../compiler/errors'
import { localizedText } from '../runtime/localized'
import { kayLog } from '../runtime/log'
import { revalidated } from './public'

export const FAVICON_DIR = 'favicon'
// kay's own mark, served when a project names no favicon: the PNG the icons are made from, and the SVG browsers draw at any size.
const DEFAULT_FAVICON = join(import.meta.dir, 'favicon.png')
const DEFAULT_SVG = join(import.meta.dir, 'favicon.svg')
const SVG = '/favicon.svg'

export const MANIFEST = '/manifest.webmanifest'
// Browsers ask for the first two at these paths on their own; the manifest points at the others.
const PNG_FILES: Record<string, number> = { '/apple-touch-icon.png': 180, '/icon-192.png': 192, '/icon-512.png': 512 }
const MASKABLE_FILES: Record<string, number> = { '/icon-maskable-192.png': 192, '/icon-maskable-512.png': 512 }
const MANIFEST_SIZES = [192, 512]
// A path of the site: one leading slash, not two, nor a backslash a browser reads as one.
const SITE_PATH = /^\/(?![/\\])/
const ICO_SIZES = [16, 32, 48]
// The widest icon kay writes, which the source must reach so none is upscaled.
const LARGEST = 512
const ICO = '/favicon.ico'

// Every path the favicon serves, an SVG one adding its SVG and a maskable manifest icon its own icons.
export const FAVICON_PATHS = [ICO, ...Object.keys(PNG_FILES), MANIFEST, SVG, ...Object.keys(MASKABLE_FILES)]

// The image the icons are made from, the SVG served beside it and the manifest's maskable image, all absolute.
export interface FaviconSource {
  image: string
  svg?: string | undefined
  maskable?: string | undefined
}

// Whether a `favicon` setting serves an SVG: kay's mark does, and a project's own when it names one or is one.
function servesSvg(favicon: string | FaviconConfig | undefined): boolean {
  return typeof favicon !== 'string' || SVG_FILE.test(favicon)
}

// The favicon's source: the project's own, kay's mark when it names none, or none once turned off.
export function faviconSource(root: string, favicon: string | FaviconConfig | false | undefined, manifest?: ManifestConfig): FaviconSource | undefined {
  if (favicon === false)
    return undefined

  const maskable = manifest?.maskable === undefined ? {} : { maskable: resolve(root, manifest.maskable) }

  if (favicon === undefined)
    return { image: DEFAULT_FAVICON, svg: DEFAULT_SVG, ...maskable }

  if (typeof favicon === 'string')
    return { image: resolve(root, favicon), ...SVG_FILE.test(favicon) && { svg: resolve(root, favicon) }, ...maskable }

  return { image: resolve(root, favicon.image), svg: resolve(root, favicon.svg), ...maskable }
}

export interface FaviconOptions {
  source: FaviconSource
  // Where `kay build` wrote the files, read instead of the source when there; a server not serving a build leaves it out, so an older build never shadows the source.
  builtDir?: string | undefined
  // The site's `seo.name` and `seo.description`; the manifest of each locale reading a text of its own is served beside the default locale's.
  name?: Localized | undefined
  description?: Localized | undefined
  locales?: ManifestLocales | undefined
  manifest?: ManifestConfig | undefined
  // The site's mount point, which the manifest's paths go under.
  base?: string | undefined
}

// The favicon in the sizes browsers ask for: an ICO of PNGs, the Apple touch icon and the manifest's icons, maskable ones included; what an SVG draws poorly goes to `warn`, kay's log by default.
// A raster source too small to draw sharp icons from goes to `enlarged`, kay's log by default, whatever `warn` is.
export async function faviconFiles({ image: source, svg, maskable }: FaviconSource, warn?: (message: string) => void, enlarged?: (message: string) => void): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const png = await drawer(source, 'favicon', warn, enlarged)
  const maskablePng = maskable === undefined ? undefined : await drawer(maskable, 'maskable icon', warn, enlarged)
  const files = new Map<string, Uint8Array<ArrayBuffer>>()

  for (const [path, size] of Object.entries(PNG_FILES))
    files.set(path, await png(size))

  files.set(ICO, ico(await Promise.all(ICO_SIZES.map(async size => png(size))), ICO_SIZES))

  if (svg !== undefined)
    files.set(SVG, await Bun.file(svg).bytes())

  if (maskablePng !== undefined) {
    for (const [path, size] of Object.entries(MASKABLE_FILES))
      files.set(path, await maskablePng(size))
  }

  return files
}

function iconType(path: string): string {
  if (path === ICO)
    return 'image/x-icon'

  return path === SVG ? 'image/svg+xml' : 'image/png'
}

// Draws the image at each size: an SVG drawn at it, so even the 16-pixel icon is sharp, an image resized to it once checked square.
async function drawer(image: string, what: string, warn?: (message: string) => void, enlarged?: (message: string) => void): Promise<(size: number) => Promise<Uint8Array<ArrayBuffer>>> {
  if (SVG_FILE.test(image)) {
    const draw = await svgIconOf(image, what, warn)

    // eslint-disable-next-line ts/require-await -- the interface returns a promise
    return async size => draw(size)
  }

  await checkSquare(image, what, enlarged)

  return async size => new Uint8Array(await new Bun.Image(image).resize(size, size).png().bytes())
}

// The SVG's drawing, through a module an executable leaves out, as it serves the icons `kay build` drew.
async function svgIconOf(file: string, what: string, warn?: (message: string) => void): Promise<(size: number) => Uint8Array<ArrayBuffer>> {
  const { svgIcon } = await import('./svg-icon')

  return svgIcon(file, what, warn)
}

// What `kay check` reports of a favicon or maskable icon given as an SVG: one with no size, not square or not drawable, and a warning for one with text.
export async function svgFaviconProblems(source: FaviconSource | undefined): Promise<{ file: string, message: string, severity?: 'warning' }[]> {
  const icons: [string | undefined, string][] = [[source?.image, 'favicon'], [source?.maskable, 'maskable icon']]
  const problems = await Promise.all(icons.map(async ([file, what]) => {
    if (file === undefined || !SVG_FILE.test(file))
      return []

    try {
      const warnings: string[] = []

      await svgIconOf(file, what, message => warnings.push(message))

      return warnings.map(message => ({ file, message: `kay: ${message}`, severity: 'warning' as const }))
    }
    catch (error) {
      return [{ file, message: error instanceof Error ? error.message : String(error) }]
    }
  }))

  return problems.flat()
}

async function checkSquare(source: string, what: string, enlarged: (message: string) => void = message => kayLog('warn', message)): Promise<void> {
  const { width, height } = await new Bun.Image(source).metadata()

  if (width !== height)
    throw new KayError('favicon-invalid', `kay: the ${what} ${source} is ${width}x${height}; it has to be square`)

  // Enlarged to the sizes it lacks, so the manifest keeps the 192 and 512 icons a browser asks for before it offers to install the site.
  if (width < LARGEST)
    enlarged(`the ${what} ${source} is ${width}x${height}, enlarged to the icons up to ${LARGEST}x${LARGEST}, which look blurred; a source of ${LARGEST}x${LARGEST} or more keeps them sharp`)
}

export async function writeFavicons(source: FaviconSource, dir: string, warn?: (message: string) => void): Promise<void> {
  await mkdir(dir, { recursive: true })

  for (const [path, bytes] of await faviconFiles(source, warn))
    await Bun.write(join(dir, path.slice(1)), bytes)
}

// An ICO holding PNG images, which every browser reads: a 6-byte header, a 16-byte entry per image, then the images.
function ico(images: Uint8Array[], sizes: number[]): Uint8Array<ArrayBuffer> {
  const header = 6 + 16 * images.length
  const bytes = new Uint8Array(header + images.reduce((total, image) => total + image.length, 0))
  const view = new DataView(bytes.buffer)
  let offset = header

  view.setUint16(2, 1, true)
  view.setUint16(4, images.length, true)

  for (const [index, image] of images.entries()) {
    const entry = 6 + 16 * index

    view.setUint8(entry, sizes[index]! % 256)
    view.setUint8(entry + 1, sizes[index]! % 256)
    view.setUint16(entry + 4, 1, true)
    view.setUint16(entry + 6, 32, true)
    view.setUint32(entry + 8, image.length, true)
    view.setUint32(entry + 12, offset, true)
    bytes.set(image, offset)
    offset += image.length
  }

  return bytes
}

// The manifest link kay itself made, which a page's locale may point at its own manifest; a `head` link of the app's is never touched.
const OWN_MANIFEST = new WeakSet<HeadTag>()

export function isOwnManifest(tag: HeadTag): boolean {
  return OWN_MANIFEST.has(tag)
}

// The links every page carries for them, which a page's own replace; an SVG is linked after the ICO, which browsers drawing SVG icons then prefer.
export function faviconTags(favicon: string | FaviconConfig | undefined): HeadTag[] {
  const manifest: HeadTag = { tag: 'link', props: { rel: 'manifest', href: MANIFEST } }

  OWN_MANIFEST.add(manifest)

  return [
    { tag: 'link', props: { rel: 'icon', href: ICO, sizes: ICO_SIZES.map(size => `${size}x${size}`).join(' ') } },
    ...servesSvg(favicon) ? [{ tag: 'link', props: { rel: 'icon', href: SVG, type: 'image/svg+xml' } } satisfies HeadTag] : [],
    { tag: 'link', props: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
    manifest,
  ]
}

// Whether the app serves the default manifest itself, as a public file, an endpoint or a page: kay then neither serves nor links the manifests of the locales.
export function appServesManifest(files: readonly { url: string }[], endpoints: readonly { pattern: string, suffix?: string | undefined }[], routes: readonly { pattern: string }[]): boolean {
  return files.some(file => file.url === MANIFEST) || endpoints.some(endpoint => `${endpoint.pattern}${endpoint.suffix ?? ''}` === MANIFEST) || routes.some(route => route.pattern === MANIFEST)
}

export interface ManifestLocales {
  locales: readonly string[]
  defaultLocale: string
}

// The manifest a locale links: the default locale's, else its own at `/manifest.fr.webmanifest` once its name or description differs from the default locale's.
export function manifestPath(locale: string | undefined, texts: { name?: Localized | undefined, description?: Localized | undefined }, defaultLocale: string | undefined): string {
  if (locale === undefined || locale === defaultLocale)
    return MANIFEST

  return ownManifest(locale, texts, defaultLocale) ? `/manifest.${locale}.webmanifest` : MANIFEST
}

function ownManifest(locale: string, texts: { name?: Localized | undefined, description?: Localized | undefined }, defaultLocale: string | undefined): boolean {
  return localizedText(texts.name, locale, defaultLocale) !== localizedText(texts.name, defaultLocale, defaultLocale) || localizedText(texts.description, locale, defaultLocale) !== localizedText(texts.description, defaultLocale, defaultLocale)
}

// The manifest of each locale other than the default's reading a name or description of its own.
export function localeManifests(texts: { name?: Localized | undefined, description?: Localized | undefined }, locales: ManifestLocales | undefined): { path: string, locale: string }[] {
  return (locales?.locales ?? []).filter(locale => locale !== locales!.defaultLocale && ownManifest(locale, texts, locales!.defaultLocale)).map(locale => ({ path: manifestPath(locale, texts, locales!.defaultLocale), locale }))
}

// Its icons, pages and scope under the site's mount point.
export function manifestJson(name: string | undefined, description: string | undefined, manifest: ManifestConfig = {}, base = ''): string {
  const scope = manifest.scope === undefined ? undefined : sitePath(manifest.scope, 'scope')
  // A browser ignores the scope when the start page lies outside it, and a shortcut outside it.
  const page = (path: string, what: string) => {
    if (scope !== undefined && !sitePath(path, what).startsWith(scope))
      throw new KayError('favicon-invalid', `kay: the manifest's ${what}, ${path}, lies outside its scope ${scope}, so browsers would ignore it`)

    return base + sitePath(path, what)
  }
  const icon = (kind: string, purpose?: string) => (size: number) => ({ src: `${base}/${kind}-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose })

  return JSON.stringify({
    name,
    short_name: manifest.shortName ?? name,
    description,
    icons: [...MANIFEST_SIZES.map(icon('icon')), ...manifest.maskable === undefined ? [] : MANIFEST_SIZES.map(icon('icon-maskable', 'maskable'))],
    start_url: page(manifest.startUrl ?? scope ?? '/', 'startUrl'),
    scope: scope === undefined ? undefined : base + scope,
    display: manifest.display,
    orientation: manifest.orientation,
    theme_color: manifest.themeColor,
    background_color: manifest.backgroundColor,
    shortcuts: manifest.shortcuts?.map((shortcut, index) => ({ name: shortcut.name, short_name: shortcut.shortName, description: shortcut.description, url: page(shortcut.url, `shortcuts[${index}].url`) })),
  })
}

function sitePath(path: string, what: string): string {
  if (!SITE_PATH.test(path))
    throw new KayError('favicon-invalid', `kay: the manifest's ${what} is a path of the site, starting with a single /, not ${path}`)

  return path
}

// Serves the favicon files and the manifest at their paths, except one the app already serves; made from the source on first request unless `kay build` wrote them.
export function serveFavicons(app: Elysia, served: ServedPaths, options: FaviconOptions): void {
  let files: Promise<Map<string, Uint8Array<ArrayBuffer>>> | undefined
  const paths = [...Object.keys(PNG_FILES), ICO, ...options.source.svg === undefined ? [] : [SVG], ...options.source.maskable === undefined ? [] : Object.keys(MASKABLE_FILES)]
  const read = async () => {
    if (options.builtDir === undefined)
      return faviconFiles(options.source)

    const built = new Map<string, Uint8Array<ArrayBuffer>>()

    for (const path of paths) {
      const file = Bun.file(join(options.builtDir, path.slice(1)))

      if (!await file.exists())
        return faviconFiles(options.source)

      built.set(path, await file.bytes())
    }

    return built
  }

  const respond = (request: Request, body: Uint8Array<ArrayBuffer> | string, type: string) => revalidated(request, `"${Bun.hash(body).toString(36)}"`, () => body, { 'content-type': type })

  for (const path of paths) {
    if (!served.offer({ path, owner: 'the favicon', kind: 'kay', exported: true }))
      continue

    app.get(path, async ({ request }) => {
      files ??= read()

      try {
        return respond(request, (await files).get(path)!, iconType(path))
      }
      catch (error) {
        // The next request tries again, once the source is fixed.
        files = undefined

        throw error
      }
    })
  }

  const texts = { name: options.name, description: options.description }
  const defaultLocale = options.locales?.defaultLocale

  const manifests = [{ path: MANIFEST, locale: defaultLocale }, ...localeManifests(texts, options.locales)]

  for (const { path, locale } of manifests) {
    const offered = served.offer({ path, owner: 'the web app manifest', kind: 'kay', exported: true })

    // The app's own manifest is the one pages link, so kay serves none of the locales'.
    if (path === MANIFEST && !offered)
      break

    if (!offered)
      continue

    const manifest = manifestJson(localizedText(options.name, locale, defaultLocale), localizedText(options.description, locale, defaultLocale), options.manifest, options.base)

    app.get(path, ({ request }) => respond(request, manifest, 'application/manifest+json'))
  }
}
