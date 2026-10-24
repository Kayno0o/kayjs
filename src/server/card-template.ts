import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { resolveFrom } from '../build/files'
import { KayError } from '../compiler/errors'
import { CARD } from '../runtime/image'
import { decodePath } from './routes'

const KAY_IMPORT = /\bfrom\s+['"]([^'"]+\.kay)['"]/g
const HTML = { 'content-type': 'text/html; charset=utf-8' }
// What a card's page may load from the build: its stylesheets, fonts and images, never the prerendered pages or a script.
const LOADABLE = /\.(?:css|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg)$/i
// Chrome's own margin and scrollbar would frame a card whose page sets neither; set first, so the page's own rules win.
const FRAME = '<style>html,body{margin:0}html{overflow:hidden}</style>'
const HEAD = /<head(?:\s[^>]*)?>/
// A card gets this long to load and be drawn, a template that never settles included; the fonts and images it loads get a part of it.
const SHOT_MS = 30_000
const SETTLE_MS = 5000
const PAINT = `(async () => {
  const loading = [...document.images].filter(image => !image.complete).map(image => new Promise(resolve => {
    image.addEventListener('load', resolve)
    image.addEventListener('error', resolve)
  }))
  await Promise.race([Promise.all([document.fonts.ready, ...loading]), new Promise(resolve => setTimeout(resolve, ${SETTLE_MS}))])
})()`

// What a card drawn from `_card.kay` depends on that no setting names: the text of the template and of every `.kay` file it imports, however deep, and the stylesheet the build made of them.
export function templateStamp(file: string, styles: string | undefined): string {
  const seen = new Set<string>()
  const texts: string[] = []
  const read = (path: string) => {
    if (seen.has(path))
      return

    seen.add(path)

    let source: string

    try {
      source = readFileSync(path, 'utf8')
    }
    catch {
      return
    }

    texts.push(path, source)

    for (const [, specifier] of source.matchAll(KAY_IMPORT)) {
      const imported = resolveFrom(specifier!, path)

      if (imported !== undefined)
        read(imported)
    }
  }

  read(file)

  return Bun.hash(JSON.stringify([texts, styles ?? ''])).toString(36)
}

// The page and the build's own stylesheets, fonts and images, for the browser a card is drawn in; a link to another host is the browser's to follow.
export async function answer(request: Request, html: string, clientDir: string): Promise<Response> {
  const path = new URL(request.url).pathname

  if (path === '/')
    return new Response(html.replace(HEAD, head => head + FRAME), { headers: HTML })

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
let idle: Timer | undefined
let browser: typeof import('../test/browser') | undefined

// The JPEG of the page `render` gives, kay's render of `_card.kay` given the address it is served at, as Chrome draws it at the card's size, from a server of its own on a port nothing else knows that serves the page and the build's files. The browser is the one kay's tests and `kay screenshot` start, which closes once no page is left.
export async function shootCard(clientDir: string, quality: number, render: (origin: string) => Promise<string>): Promise<Uint8Array> {
  const previous = tail
  const { promise, resolve } = Promise.withResolvers<void>()

  tail = promise
  waiting++
  clearTimeout(idle)

  try {
    await previous

    return await draw(clientDir, quality, render)
  }
  finally {
    resolve()

    if (--waiting === 0) {
      idle = setTimeout(() => browser?.releaseIdleBrowser(), IDLE_MS)
      idle.unref()
    }
  }
}

async function draw(clientDir: string, quality: number, render: (origin: string) => Promise<string>): Promise<Uint8Array> {
  // Imported as it is asked for: only an app with a card template needs the browser module.
  const { browse, browserPath } = browser ??= await import('../test/browser')

  if (browserPath() === undefined)
    throw new KayError('share-card-invalid', 'kay: src/routes/_card.kay is drawn in Chrome or Chromium, and none was found; install one, or give its path as BUN_CHROME_PATH')

  let html = ''
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => answer(request, html, clientDir) })
  let timer: Timer | undefined

  try {
    const shot = (async () => {
      // Rendered once the port is known, for the page to name the image by the address the browser reaches it at.
      html = await render(`http://127.0.0.1:${server.port}`)

      const page = await browse(`http://127.0.0.1:${server.port}/`, { width: CARD.width, height: CARD.height, javaScript: false, strict: false, lenient: true, timeout: `${SHOT_MS}ms` })

      // Closed by the shot itself, so a shot that lost the race to the timeout still frees its page when it ends.
      try {
      // The window is taller than the page's viewport by the browser's own bar.
        await page.view.cdp('Emulation.setDeviceMetricsOverride', { width: CARD.width, height: CARD.height, deviceScaleFactor: 1, mobile: false })
        await page.view.cdp('Runtime.evaluate', { expression: PAINT, awaitPromise: true })

        const { data } = await page.view.cdp<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality, clip: { x: 0, y: 0, width: CARD.width, height: CARD.height, scale: 1 } })

        return Uint8Array.fromBase64(data)
      }
      finally {
        page.close()
      }
    })()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new KayError('share-card-invalid', `kay: src/routes/_card.kay was not drawn within ${SHOT_MS / 1000} s, the browser stopped answering`)), SHOT_MS)
    })

    // A shot that lost the race is left to fail on its own, its page closed below.
    void Promise.allSettled([shot])

    return await Promise.race([shot, timeout])
  }
  finally {
    clearTimeout(timer)
    await server.stop(true)
  }
}
