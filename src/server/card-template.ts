import type { ImageRouteOptions } from './image'
import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { resolveFrom } from '../build/files'
import { KayError } from '../compiler/errors'
import { CARD, IMAGE_ROUTE } from '../runtime/image'
import { decodePath } from './routes'

const IMPORT = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g
const SOURCE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
const NODE_MODULES = `${sep}node_modules${sep}`
const HTML = { 'content-type': 'text/html; charset=utf-8' }
// What a card's page may load from the build: its stylesheets, fonts and images, never the prerendered pages or a script.
const LOADABLE = /\.(?:css|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg)$/i
// Chrome's own margin and scrollbar would frame a card whose page sets neither; set first, so the page's own rules win.
const FRAME = '<style>html,body{margin:0}html{overflow:hidden}</style>'
const HEAD = /<head(?:\s[^>]*)?>/
// A card gets this long to load and be drawn, a template that never settles included; the fonts and images it loads get a part of it.
const DEFAULT_SHOT_MS = 30_000
let shotMs = DEFAULT_SHOT_MS
const SETTLE_MS = 15_000
const POLL_MS = 50
// The page runs no script of its own and timers and frames do not run in it, so this only waits on the fonts and images, and sets a flag the card's shot polls: a lazy image would otherwise never start loading outside the first frame, and one decoded off the main thread may be loaded and still undrawn.
const PAINT = `(() => {
  window.__kayPainted = false
  Promise.all([document.fonts.ready, ...[...document.images].map(async image => {
    image.loading = 'eager'

    if (!image.complete) {
      await new Promise(resolve => {
        image.addEventListener('load', resolve)
        image.addEventListener('error', resolve)
      })
    }

    try {
      await image.decode()
    }
    catch {}
  })]).then(() => { window.__kayPainted = true })
})()`

// Cuts the limit for a test, or restores it with no argument.
export function setCardShotLimit(ms = DEFAULT_SHOT_MS): void {
  shotMs = ms
}

// What a card drawn from `_card.kay` depends on that no setting names: the text of the template and of every `.kay`, `.ts` or `.js` file of the app it imports, however deep, the content of the images and other files it imports, the stylesheet the build made of them and the font rules the page carries.
export function templateStamp(file: string, styles: string | undefined, fonts?: string | undefined, projectDir: string = dirname(file)): string {
  const seen = new Set<string>()
  const texts: string[] = []
  const root = projectDir + sep
  const read = (path: string) => {
    if (seen.has(path))
      return

    seen.add(path)

    let bytes: Buffer

    try {
      bytes = readFileSync(path)
    }
    catch {
      return
    }

    if (!SOURCE_FILE.test(path)) {
      texts.push(path, Bun.hash(bytes).toString(36))

      return
    }

    const source = bytes.toString('utf8')

    texts.push(path, source)

    for (const [, specifier] of source.matchAll(IMPORT)) {
      const imported = resolveFrom(specifier!, path)

      // Another package's files are its version's, and the framework's own are kay's.
      if (imported !== undefined && imported.startsWith(root) && !imported.includes(NODE_MODULES))
        read(imported)
    }
  }

  read(file)

  return Bun.hash(JSON.stringify([texts, styles ?? '', fonts ?? ''])).toString(36)
}

// The page, the build's own stylesheets, fonts and images, and the image route for the images the build holds no file of, for the browser a card is drawn in; a link to another host is the browser's to follow.
export async function answer(request: Request, html: string, clientDir: string, images?: ((request: Request) => Promise<Response>) | undefined): Promise<Response> {
  const path = new URL(request.url).pathname

  if (path === '/')
    return new Response(html.replace(HEAD, head => head + FRAME), { headers: HTML })

  if (path === IMAGE_ROUTE && images !== undefined)
    return images(request)

  const parts = path.startsWith(ASSET_PREFIX) ? path.slice(ASSET_PREFIX.length).split('/') : []
  const names = parts.flatMap(part => decodePath(part) ?? [])
  const file = names.length === 0 || names.length !== parts.length || names.some(name => name.includes('\0')) ? undefined : resolve(clientDir, ...names)

  if (file === undefined || !file.startsWith(clientDir + sep) || !LOADABLE.test(file) || !await Bun.file(file).exists())
    return new Response('Not Found', { status: 404 })

  return new Response(Bun.file(file))
}

// One card at a time, so a burst of requests costs one tab of the browser rather than one each. The browser stays open between the cards of a build and closes a moment after the last one.
const IDLE_MS = 3000
let tail: Promise<void> = Promise.resolve()
let waiting = 0

// How many cards the server draws or has waiting before it turns the next request away, each one being a tab of Chrome.
export const MAX_QUEUED = 16
let idle: Timer | undefined
let browser: typeof import('../test/browser') | undefined
// The image route of the cards being drawn, kept while the browser is, for the cards of a burst to share its caches.
let routed: { options: ImageRouteOptions, handle: (request: Request) => Promise<Response> } | undefined

// The JPEG of the page `render` gives, kay's render of `_card.kay` given the address it is served at, as Chrome draws it at the card's size, from a server of its own on a port nothing else knows that serves the page and the build's files. The browser is the one kay's tests and `kay screenshot` start, which closes once no page is left.
export async function shootCard(clientDir: string, quality: number, render: (origin: string) => Promise<string>, images?: ImageRouteOptions | undefined): Promise<Uint8Array> {
  const previous = tail
  const { promise, resolve } = Promise.withResolvers<void>()

  tail = promise
  waiting++
  clearTimeout(idle)

  try {
    await previous

    return await draw(clientDir, quality, render, images)
  }
  finally {
    resolve()

    if (--waiting === 0) {
      idle = setTimeout(() => {
        routed = undefined
        browser?.releaseIdleBrowser()
      }, IDLE_MS)
      idle.unref()
    }
  }
}

// The image route over `options`, answering in this process: the images of `images.dirs` and `images.remote`, and the variants of an imported one, as the app's own route would.
export async function imageRoute(options: ImageRouteOptions): Promise<(request: Request) => Promise<Response>> {
  if (routed?.options === options)
    return routed.handle

  const [{ Elysia }, { serveImages }] = await Promise.all([import('elysia'), import('./image')])
  const app = new Elysia()

  // No guard of `images.resolve` runs: a card shows what is public.
  serveImages(app, { ...options, resolve: undefined })
  routed = { options, handle: async request => app.handle(request) }

  return routed.handle
}

async function draw(clientDir: string, quality: number, render: (origin: string) => Promise<string>, images: ImageRouteOptions | undefined): Promise<Uint8Array> {
  // Imported as it is asked for: only an app with a card template needs the browser module.
  const { browse, browserPath } = browser ??= await import('../test/browser')

  if (browserPath() === undefined)
    throw new KayError('share-card-invalid', 'kay: src/routes/_card.kay is drawn in Chrome or Chromium, and none was found; install one, or give its path as BUN_CHROME_PATH')

  const route = images && await imageRoute(images)
  let html = ''
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => answer(request, html, clientDir, route) })
  let timer: Timer | undefined
  let opened: { close: () => void } | undefined
  let expired = false
  const limit = shotMs

  try {
    const shot = (async () => {
      // Rendered once the port is known, for the page to name the image by the address the browser reaches it at.
      html = await render(`http://127.0.0.1:${server.port}`)

      const page = await browse(`http://127.0.0.1:${server.port}/`, { width: CARD.width, height: CARD.height, javaScript: false, strict: false, lenient: true, timeout: `${limit}ms` })

      opened = page

      // Opened after the timeout won: nothing waits for this shot any more, so its page closes at once.
      if (expired) {
        page.close()

        throw new KayError('share-card-invalid', 'kay: src/routes/_card.kay was not drawn in time')
      }

      // Closed by the shot itself, and below when it never ends, so the next card starts with no page of this one left open.
      try {
      // The window is taller than the page's viewport by the browser's own bar.
        await page.view.cdp('Emulation.setDeviceMetricsOverride', { width: CARD.width, height: CARD.height, deviceScaleFactor: 1, mobile: false })
        await page.view.cdp('Runtime.evaluate', { expression: PAINT })

        // The fonts and images get this long, as a host that never answers would hold the shot back to its limit.
        for (const until = Date.now() + SETTLE_MS; Date.now() < until;) {
          const { result } = await page.view.cdp<{ result: { value?: boolean } }>('Runtime.evaluate', { expression: 'window.__kayPainted', returnByValue: true })

          if (result.value === true)
            break

          await Bun.sleep(POLL_MS)
        }

        const { data } = await page.view.cdp<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality, clip: { x: 0, y: 0, width: CARD.width, height: CARD.height, scale: 1 } })

        return Uint8Array.fromBase64(data)
      }
      finally {
        page.close()
      }
    })()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true
        reject(new KayError('share-card-invalid', `kay: src/routes/_card.kay was not drawn within ${limit / 1000} s, the browser stopped answering`))
      }, limit)
    })

    // A shot that lost the race is left to fail on its own, its page closed below.
    void Promise.allSettled([shot])

    return await Promise.race([shot, timeout])
  }
  finally {
    clearTimeout(timer)
    opened?.close()
    await server.stop(true)
  }
}
