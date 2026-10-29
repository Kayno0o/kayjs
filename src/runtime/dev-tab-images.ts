import type { DevKit, DevTab, DevTool } from './dev-tool'

// The Images tab's code, fetched at once as its badge counts what is wrong with the page's images, with the tool's shared helpers from `tool.kit`.
const BUILT_EVENT = 'kay-dev-built'
// An image served more than this many times the pixels it is drawn with is flagged: the ladder's widths are at most 2 apart, so a variant picked for the size drawn is under 2 times as wide, 4 times the pixels, even at its worst.
const OVERSIZED = 4
const IMAGE_ROUTE = '/_kay/image'
const SVG_TYPE = /^image\/svg\+xml\s*(?:;|$)/i
// The files `kay build` wrote for the variants.
const IMAGE_FILES = '/_kay/images/'
// How many formats are asked of the server at once, and how long one gets.
const IMAGE_REQUESTS = 4
const IMAGE_REQUEST_MS = 3000
const VARIANT_FILE = /-(card|\d+)(?:-(\d+x\d+))?\.(?:webp|avif|jpg)$/
// The accept header browsers send for an image, which the image route picks AVIF or WebP from.
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'

interface ImageInfo {
  image: HTMLImageElement
  // The URL in use, shortened to its path and the `src` of the image route.
  url: string
  // The address the browser loaded.
  src: string
  variant: string
  natural: string
  drawn: string
  // What is wrong with it, one sentence each.
  flags: string[]
  lcp: boolean
}

// A URL's path with its percent-encoding read; a name that is not valid percent-encoding is read as it is.
function decodedPath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname)
  }
  catch {
    return url.pathname
  }
}

// What kay's URL for an image says it is: a width of the ladder, a crop, the share card, a file `kay build` wrote, or an image kay did not resize.
function imageVariant(kit: DevKit, src: string, origin: string): string {
  const url = kit.parseUrl(src, origin)

  if (url === undefined || url.origin !== origin)
    return 'not resized by kay'

  if (url.pathname === IMAGE_ROUTE) {
    const crop = url.searchParams.get('crop')

    return url.searchParams.has('card') ? 'share card, 1200x630, resized on request' : `${url.searchParams.get('w') ?? 'original'}w${crop === null ? '' : `, cut ${crop}`}, resized on request`
  }

  const path = decodedPath(url)

  const file = VARIANT_FILE.exec(path)

  if (path.startsWith('/_kay/images/') && file)
    return `${file[1] === 'card' ? 'share card' : `${file[1]}w`}${file[2] === undefined ? '' : `, cut ${file[2]}`}, written by kay build`

  return 'not resized by kay'
}

// Whether an image is an SVG: a path ending in `.svg` whatever its query or hash, else the content type its fetch answered, as Resource Timing kept it, since asking again could run the app's own handler. The browser gives an SVG without a size a natural size of 150x150, and an SVG draws at any size from the same bytes, so its natural size says nothing about what was served.
function isVector(kit: DevKit, src: string, win: Window & typeof globalThis): boolean {
  const url = kit.parseUrl(src, win.location.href)

  if (url === undefined)
    return false

  if (decodedPath(url).toLowerCase().endsWith('.svg'))
    return true

  url.hash = ''

  return win.performance.getEntriesByName(url.href, 'resource').some(entry => 'contentType' in entry && typeof entry.contentType === 'string' && SVG_TYPE.test(entry.contentType))
}

// Every image of the page with what it is, what it is drawn at and what is wrong with it; `lcp` is the element the browser reported as the largest paint.
function pageImages(kit: DevKit, doc: Document, lcp: Element | undefined): ImageInfo[] {
  const win = doc.defaultView!
  const density = win.devicePixelRatio || 1
  // Chromium reports a zoom's density as a float, 1.2000000476837158 at 120%.
  const shown = Number(density.toFixed(2))

  return [...doc.querySelectorAll('img')].flatMap((image) => {
    const src = image.currentSrc === '' ? image.getAttribute('src') : image.currentSrc

    if (src === null || src === '' || src.startsWith('data:'))
      return []

    const box = image.getBoundingClientRect()
    const flags: string[] = []
    const served = image.naturalWidth * image.naturalHeight
    const needed = box.width * box.height * density * density

    if (served > 0 && needed > 0 && served > needed * OVERSIZED && !isVector(kit, src, win))
      flags.push(`served ${Math.round(served / needed)} times the pixels it is drawn with, give it a smaller width or \`sizes\``)

    if (!image.hasAttribute('width') || !image.hasAttribute('height'))
      flags.push('no width and height, so the page shifts as it loads')

    if (image.loading === 'lazy' && box.bottom > 0 && box.top < win.innerHeight && box.right > 0 && box.left < win.innerWidth)
      flags.push('lazy-loaded but in view, which delays it')

    return [{
      image,
      url: src.replace(win.location.origin, ''),
      src,
      variant: imageVariant(kit, src, win.location.origin),
      natural: image.naturalWidth > 0 ? `${image.naturalWidth}x${image.naturalHeight}` : 'not loaded',
      drawn: `${Math.round(box.width)}x${Math.round(box.height)}${shown === 1 ? '' : ` at ${shown}x`}`,
      flags,
      lcp: image === lcp,
    }]
  })
}

// The images of the page: the variant and format each got, the size served against the size drawn, which one is the largest paint, and what is wrong with it; hovering or focusing a row outlines the image, and the list is read again as the tab shows and as the page changes under it.
export default function imagesTab(tool: DevTool, tab: DevTab): () => void {
  const { copyButton, entry, filterable, pill, signal, toolbar, vitals } = tool.kit
  const doc = tool.root.ownerDocument
  const win = doc.defaultView!
  let asked = 0
  let reread: () => void = () => undefined
  const content = tool.make('div', 'stack')
  const bar = toolbar('Filter by address, variant or problem', () => bar.apply(content), true)
  // What the server answered an image with, by address, until the next rebuild; a failed lookup is kept too, so a reread does not send one more request per failing image.
  const answers = new Map<string, Promise<string>>()
  const slots = limiter(IMAGE_REQUESTS)
  let scheduled = false
  const schedule = () => {
    if (scheduled)
      return

    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      reread()
    })
  }

  vitals.changed.push((name) => {
    if (name === 'lcp')
      schedule()
  })

  const read = async () => {
    const ask = ++asked
    const images = pageImages(tool.kit, doc, vitals.lcp?.element?.isConnected === true ? vitals.lcp.element : undefined)
    const body = tool.make('div')
    const formats: HTMLElement[] = []
    const flagged = images.filter(info => info.flags.length > 0).length

    tab.count(images.reduce((sum, info) => sum + info.flags.length, 0), flagged > 0 ? 'warn' : undefined)

    // Closed, the tab only keeps its count; the rows and the format lookups wait for it to be opened.
    if (tab.panel.hidden === true)
      return

    tool.hideOutline()

    bar.element.hidden = images.length === 0

    if (images.length === 0) {
      content.replaceChildren(tool.make('div', 'empty', 'No images on this page.'))

      return
    }

    // Copies of one image drawn at one size share a row, as the logo of a header and a footer would, with what is wrong with any of them.
    const copies = new Map<string, ImageInfo[]>()

    for (const info of images) {
      const key = JSON.stringify([info.src, info.variant, info.drawn])
      const same = copies.get(key)

      if (same === undefined)
        copies.set(key, [info])
      else
        same.push(info)
    }

    const rows = [...copies.values()]

    for (const same of rows) {
      const info = same[0]!
      const lcp = same.some(copy => copy.lcp)
      const thumb = tool.make('img', 'thumb')
      const format = tool.make('span', 'chip', 'format...')
      const label = lcp ? 'largest paint' : 'image'
      const issues = [...new Set(same.flatMap(copy => copy.flags))]
      const row = entry('image', {
        lead: thumb,
        name: info.url,
        after: [...lcp ? [pill('largest paint', 'accent')] : [], ...same.length > 1 ? [pill(`${same.length} copies`)] : [], copyButton('the address', info.src)],
        chips: [info.variant, format, info.natural === 'not loaded' ? `not loaded, drawn ${info.drawn}` : `${info.natural} drawn ${info.drawn}`],
        issues: issues.map(text => ({ text, tone: 'warn' as const })),
      })

      formats.push(format)
      thumb.src = info.src
      thumb.alt = ''
      thumb.loading = 'lazy'
      thumb.decoding = 'async'
      row.tabIndex = 0
      row.setAttribute('role', 'group')
      row.setAttribute('aria-label', same.length > 1 ? `${info.url}, ${same.length} copies` : info.url)
      row.onpointerenter = row.onfocus = () => tool.outline(same.map(copy => copy.image), label)
      row.onpointerleave = row.onblur = () => tool.hideOutline()
      body.append(filterable(row, [info.url, info.variant, ...issues].join(' '), issues.length > 0))
    }

    content.replaceChildren(tool.make('div', 'note', `${images.length} image${images.length === 1 ? '' : 's'}, ${flagged} to look at`), body, bar.empty, tool.make('div', 'note', 'Formats are those the server picks for a browser accepting AVIF and WebP. Those of images kay does not serve are not looked up, as asking could run the app\'s own handler.'))
    bar.apply(content)

    // An image the server is not asked about answers at once; the others go a few at a time, so a page of many images does not ask the server for all of them at once, and one that hangs holds back one slot only.
    await Promise.all(rows.map(async (same, index) => {
      const info = same[0]!
      let text = unaskedFormat(tool.kit, win, info.image, info.src)

      if (text === undefined) {
        let answer = answers.get(info.src)

        if (answer === undefined) {
          answer = slots(async () => askedFormat(tool.kit, win, info.src))
          answers.set(info.src, answer)
        }

        text = await answer
      }

      if (ask === asked)
        formats[index]!.textContent = text
    }))
  }

  reread = () => void read()
  tab.panel.append(bar.element, content)
  doc.addEventListener('load', schedule, { capture: true, signal })
  doc.addEventListener('error', schedule, { capture: true, signal })
  win.addEventListener(BUILT_EVENT, () => {
    answers.clear()
    schedule()
  }, { signal })

  const changes = new MutationObserver(schedule)

  changes.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes', 'loading', 'width', 'height'] })
  signal.addEventListener('abort', () => changes.disconnect())
  schedule()

  return () => reread()
}

// A limit on how many calls of a kind run at once; the rest wait their turn.
function limiter(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []

  return async (run) => {
    if (running >= max)
      await new Promise<void>(resolve => waiting.push(resolve))

    running++

    try {
      return await run()
    }
    finally {
      running--
      waiting.shift()?.()
    }
  }
}

// The format of an image the server is not asked about, or undefined for one that is. Only an image of kay's own routes loaded by the page is asked, with a HEAD request: the route's code is kay's, it writes no variant the page did not already draw, and the type is negotiated so the URL does not say it. Any other image could run the app's own handler, so its size comes from the browser's resource timing and its format is not looked up.
function unaskedFormat(kit: DevKit, win: Window & typeof globalThis, image: HTMLImageElement, src: string): string | undefined {
  // The page's policy lets it ask its own origin only.
  const url = kit.parseUrl(src, win.location.href)

  if (url === undefined)
    return 'format unknown'

  if (url.origin !== win.location.origin)
    return 'on another host'

  if (url.pathname !== IMAGE_ROUTE && !url.pathname.startsWith(IMAGE_FILES))
    return `format not looked up${transferred(kit, win, url.href)}`

  return !image.complete || image.naturalWidth === 0 ? 'not loaded' : undefined
}

// The format and size the server gives an image of kay's routes.
async function askedFormat(kit: DevKit, win: Window & typeof globalThis, src: string): Promise<string> {
  try {
    const response = await kit.ownFetch(win, src, { method: 'HEAD', headers: { accept: IMAGE_ACCEPT }, cache: 'no-store', signal: AbortSignal.timeout(IMAGE_REQUEST_MS) })
    const type = response.headers.get('content-type') ?? ''

    if (!response.ok)
      return `the server answered ${response.status}`

    const format = type.startsWith('image/') ? type.slice('image/'.length) : 'not an image'
    const bytes = Number(response.headers.get('content-length'))

    return bytes > 0 ? `${format}, ${kit.formatBytes(bytes)}` : format
  }
  catch {
    return 'format unknown'
  }
}

// What the browser says it downloaded for an address, as ` - 12.0 KB`; nothing when it did not report it.
function transferred(kit: DevKit, win: Window & typeof globalThis, href: string): string {
  const entry = win.performance.getEntriesByName(href, 'resource').at(-1) as PerformanceResourceTiming | undefined

  return entry !== undefined && entry.encodedBodySize > 0 ? `, ${kit.formatBytes(entry.encodedBodySize)}` : ''
}
