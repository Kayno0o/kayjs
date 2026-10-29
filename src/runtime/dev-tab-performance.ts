import type { DevKit, DevTab, DevTool, VitalName } from './dev-tool'

// The Performance tab's code, fetched at once as its badge counts the vitals past their limits, with the tool's shared helpers from `tool.kit`.
const HOST = 'kay-dev'
const SIZES_URL = '/_kay/dev/sizes'
const FOOTPRINT_URL = '/_kay/dev/footprint'
const HEAD_HEADER = 'x-kay-dev'
const REQUEST_MS = 3000
const RATING_TONES = { good: 'ok', needs: 'warn', poor: 'error' } as const
// The Web Vitals "good" and "poor" limits: a value up to the first is good, past the second poor.
const VITAL_LIMITS = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500] } as const

function worstTone(bad: string[]): 'error' | 'warn' | undefined {
  if (bad.includes('poor'))
    return 'error'

  return bad.length > 0 ? 'warn' : undefined
}

function rateVital(name: VitalName, value: number): 'good' | 'needs' | 'poor' {
  const [good, poor] = VITAL_LIMITS[name]

  if (value <= good)
    return 'good'

  return value <= poor ? 'needs' : 'poor'
}

interface BuiltSizes {
  route: string
  js: number
  css: number
  estimated: boolean
  exported: boolean
  built: number
}

// What the last `kay build` measured for this page's route, which the server reads from the report kept under `.kay`; nothing when no build was made or the route is not in it.
async function builtSizes(kit: DevKit, win: Window & typeof globalThis): Promise<BuiltSizes | undefined> {
  try {
    const response = await kit.ownFetch(win, `${SIZES_URL}?path=${encodeURIComponent(win.location.pathname)}`, { headers: { [HEAD_HEADER]: '1' }, cache: 'no-store', signal: AbortSignal.timeout(REQUEST_MS) })

    return response.ok ? ((await response.json()) as { sizes?: BuiltSizes }).sizes : undefined
  }
  catch {
    return undefined
  }
}

// How long ago, in the largest whole unit.
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)

  if (minutes < 1)
    return 'less than a minute ago'

  if (minutes < 60)
    return `${minutes} min ago`

  if (minutes < 1440)
    return `${Math.floor(minutes / 60)} h ago`

  const days = Math.floor(minutes / 1440)

  return days === 1 ? '1 day ago' : `${days} days ago`
}

// The gzipped size of some text, as a server would send it.
async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))

  return (await new Response(stream).arrayBuffer()).byteLength
}

// The page's HTML as the browser holds it, without the dev tool: what the server sent, as live reload and swaps changed it, so the server renders nothing again.
function deliveredHtml(doc: Document): string {
  const copy = doc.documentElement.cloneNode(true) as HTMLElement

  for (const host of copy.querySelectorAll(HOST))
    host.remove()

  return `<!doctype html>${copy.outerHTML}`
}

const MEDIA_KINDS: Record<string, 'images' | 'fonts'> = { font: 'fonts', image: 'images' }

interface Weight {
  html: number
  css: { url: string, bytes: number }[]
  entry: { url: string, bytes: number }[]
  islands: { url: string, bytes: number }[]
  other: { url: string, bytes: number }[]
  images: { url: string, bytes: number }[]
  fonts: { url: string, bytes: number }[]
  files: { url: string, bytes: number }[]
  // The page's elements and the requests it made, the document's own included, for the EcoIndex.
  dom: number
  requests: number
  // Requests whose size the browser does not tell, another site's or one it kept in memory, counted as requests only.
  unweighed: number
}

// A built file's name without its hash, `counter` of `counter-48rr5xzz.js`.
const HASHED_NAME = /^(.*)-[a-z\d]{8}\.(?:js|css)$/
const DIRECTORY_PREFIX = /^.*\//
const KAY_SUFFIX = /\.kay$/
const SCRIPT_OR_STYLE = /\.(?:js|css)$/

// The page's HTML (the document the browser holds), the stylesheets and scripts it loaded gzipped, as sent in development: not minified, with the dev-only code, so larger than `kay build` makes them. The images, fonts and other files it loaded count as many bytes as the browser says came. The dev tool's own scripts, the live reload and the public env stay out; a file rebuilt since it first loaded counts once, in its latest form, and a stylesheet only while the page links it.
async function pageWeight(kit: DevKit, doc: Document): Promise<Weight> {
  const win = doc.defaultView!
  const here = win.location.origin
  const linked = new Set([...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => new URL(link.href, here).pathname))
  const latest = new Map<string, string>()
  const media = new Map<string, { url: string, bytes: number, kind: 'images' | 'fonts' | 'files', known: boolean }>()
  const components = new Set([...doc.querySelectorAll('[data-component]')].map(element => (element.getAttribute('data-component') ?? '').replace(DIRECTORY_PREFIX, '').replace(KAY_SUFFIX, '')))

  for (const entry of win.performance.getEntriesByType('resource')) {
    const url = kit.parseUrl(entry.name, here)

    if (url === undefined)
      continue

    const own = url.origin === here

    if (own && (url.pathname.startsWith('/_kay/dev/') || url.pathname === '/_kay/env.js'))
      continue

    if (!own || !SCRIPT_OR_STYLE.test(url.pathname)) {
      const fetched = entry as PerformanceResourceTiming
      const kind = kit.fetchKind(fetched, url)

      // A page a swap or prefetch fetched and an action are the visitor's moves, not what the page loaded.
      if (kind === 'page' || kind === 'action')
        continue

      const bytes = [fetched.encodedBodySize, fetched.transferSize].find(size => size > 0) ?? 0

      media.set(url.href, { url: own ? `${url.pathname}${url.search}` : url.href, bytes, kind: MEDIA_KINDS[kind] ?? 'files', known: bytes > 0 })

      continue
    }

    if (url.pathname.endsWith('.css') && !linked.has(url.pathname))
      continue

    const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    const name = HASHED_NAME.exec(file)?.[1]

    // Later entries are later loads: the hash of the entry or an island rebuilt since replaces the one before. Any other file keeps its address, as a name ending in 8 letters, `chart-calendar.js`, may not be hashed at all.
    latest.set(name === undefined || !(name === 'entry' || components.has(name)) ? url.pathname : `${url.pathname.slice(0, url.pathname.length - file.length)}${name}.${file.slice(file.lastIndexOf('.') + 1)}`, url.pathname)
  }

  const sized = async (url: string, accept = '*/*') => {
    const response = await kit.ownFetch(win, url, { headers: { accept } })

    if (!response.ok)
      throw new Error(`${url} answered ${response.status}`)

    return gzipSize(await response.text())
  }
  const settled = await Promise.allSettled([...latest.values()].map(async url => ({ url, bytes: await sized(url) })))
  const files = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const isEntry = (url: string) => url.slice(url.lastIndexOf('/') + 1).startsWith('entry-')
  const isIsland = (url: string) => components.has(HASHED_NAME.exec(url.slice(url.lastIndexOf('/') + 1))?.[1] ?? '')
  const scripts = files.filter(file => file.url.endsWith('.js'))
  const loaded = [...media.values()]
  const ofKind = (kind: 'images' | 'fonts' | 'files') => loaded.filter(file => file.kind === kind && file.known)

  return {
    // The root and its descendants, as the EcoIndex counts them, without the dev tool's own.
    dom: 1 + doc.documentElement.querySelectorAll('*').length - [...doc.querySelectorAll(HOST)].reduce((sum, host) => sum + 1 + host.querySelectorAll('*').length, 0),
    requests: 1 + latest.size + media.size,
    unweighed: loaded.filter(file => !file.known).length,
    images: ofKind('images'),
    fonts: ofKind('fonts'),
    files: ofKind('files'),
    html: await gzipSize(deliveredHtml(doc)),
    css: files.filter(file => file.url.endsWith('.css')),
    entry: scripts.filter(file => isEntry(file.url)),
    islands: scripts.filter(file => !isEntry(file.url) && isIsland(file.url)),
    other: scripts.filter(file => !isEntry(file.url) && !isIsland(file.url)),
  }
}

interface Footprint {
  score: number
  grade: string
  co2: number
  ecoindex: string
  swd: number
}

const GRADE_TONES = { A: 'ok', B: 'ok', C: 'warn', D: 'warn' } as const

// The EcoIndex and the carbon of the page, worked out on the server by the models `kay build` uses; nothing when it does not answer.
async function pageFootprint(kit: DevKit, win: Window & typeof globalThis, weight: Weight, bytes: number): Promise<Footprint | undefined> {
  try {
    const response = await kit.ownFetch(win, `${FOOTPRINT_URL}?dom=${weight.dom}&requests=${weight.requests}&bytes=${bytes}`, { headers: { [HEAD_HEADER]: '1' }, cache: 'no-store', signal: AbortSignal.timeout(REQUEST_MS) })

    return response.ok ? (await response.json()) as Footprint : undefined
  }
  catch {
    return undefined
  }
}

// How far past the poor limit a vital's scale reaches.
const SCALE_PAST_POOR = 1.25

// A vital's value as its digits and its unit, and a limit as a tick under its scale.
function vitalDigits(name: VitalName, value: number): [string, string] {
  return name === 'cls' ? [value.toFixed(3), ''] : [String(Math.round(value)), 'ms']
}

function vitalTick(name: VitalName, limit: number): string {
  return name !== 'cls' && limit >= 1000 ? `${limit / 1000} s` : String(limit)
}

// The page's weight and Web Vitals: LCP, CLS and INP each as a tile with its scale, good and poor limits marked, as the page is used, and the HTML, CSS and JS gzipped as bars, the island chunks split from the entry.
export default function performanceTab(tool: DevTool, tab: DevTab): () => void {
  const { formatBytes, pill, signal, vitals } = tool.kit
  const doc = tool.root.ownerDocument
  let scheduled = false
  let reread: () => void = () => undefined
  const vitalsPanel = tool.make('div', 'vitals')
  const weightPanel = tool.make('section', 'group')
  const footprintPanel = tool.make('section', 'group')
  const loadNote = tool.make('div', 'note')
  let asked = 0
  const vital = (name: VitalName, label: string, value: number | undefined, detail?: string) => {
    const [good, poor] = VITAL_LIMITS[name]
    const tile = tool.make('div', 'vital')
    const top = tool.make('div', 'top')
    const number = tool.make('span', 'num')
    const box = tool.make('div', 'scalebox')
    const scale = tool.make('div', 'scale')
    const reach = poor * SCALE_PAST_POOR
    const part = (className: string, from: number, to: number) => {
      const segment = tool.make('i', className)

      segment.style.width = `${(to - from) / reach * 100}%`
      scale.append(segment)
    }
    const tick = (limit: number) => {
      const element = tool.make('span', 'tick', vitalTick(name, limit))

      element.style.left = `${limit / reach * 100}%`
      box.append(element)
    }

    top.append(tool.make('span', 'name', label))
    part('g', 0, good)
    part('n', good, poor)
    part('p', poor, reach)
    box.append(scale)
    tick(good)
    tick(poor)

    if (value === undefined) {
      number.append(tool.make('span', 'note', name === 'inp' ? 'no interaction yet' : 'not reported yet'))
    }
    else {
      const rating = rateVital(name, value)
      const [digits, unit] = vitalDigits(name, value)
      const marker = tool.make('span', 'mk')

      marker.style.left = `${Math.min(100, value / reach * 100)}%`
      box.append(marker)
      top.append(pill(rating === 'needs' ? 'needs work' : rating, RATING_TONES[rating]))
      number.append(digits)

      if (unit !== '')
        number.append(tool.make('small', '', unit))
    }

    tile.append(top, number, box)

    if (detail !== undefined && value !== undefined)
      tile.append(tool.make('span', 'note', detail))

    vitalsPanel.append(tile)
  }
  const renderVitals = () => {
    const element = vitals.lcp?.element
    const painted = element === undefined ? undefined : `${element.localName}${element.id === '' ? '' : `#${element.id}`}`
    const rated = [vitals.lcp?.ms === undefined ? undefined : rateVital('lcp', vitals.lcp.ms), vitals.inp === undefined ? undefined : rateVital('inp', vitals.inp), rateVital('cls', vitals.cls)]
    const bad = rated.filter(rating => rating !== undefined && rating !== 'good')

    loadNote.textContent = doc.defaultView!.location.pathname === vitals.path ? `Measured on the load of ${vitals.path}.` : `Measured on the load of ${vitals.path}, not on this page: a link swapped it in without a load.`
    vitalsPanel.replaceChildren()
    vital('lcp', 'LCP', vitals.lcp?.ms, painted === undefined ? undefined : `painted: ${painted}`)
    vital('cls', 'CLS', vitals.cls)
    vital('inp', 'INP', vitals.inp)
    tab.count(bad.length, worstTone(bad))
  }
  const reload = async () => {
    const ask = ++asked

    renderVitals()
    weightPanel.replaceChildren(tool.make('div', 'note', 'Measuring the weight...'))
    footprintPanel.replaceChildren()

    let weight: Weight

    try {
      weight = await pageWeight(tool.kit, doc)
    }
    catch (error) {
      if (ask === asked)
        weightPanel.replaceChildren(tool.make('div', 'empty', `Could not measure the weight: ${error instanceof Error ? error.message : String(error)}`))

      return
    }

    if (ask !== asked)
      return

    const grid = tool.make('div', 'weight')
    const total = (files: { bytes: number }[]) => files.reduce((sum, file) => sum + file.bytes, 0)
    const rows: [string, number, { url: string, bytes: number }[]][] = [
      ['HTML', weight.html, []],
      ['CSS', total(weight.css), weight.css],
      ...([['Entry', weight.entry], ['Islands', weight.islands], ['Other chunks', weight.other], ['Images', weight.images], ['Fonts', weight.fonts], ['Other files', weight.files]] as const).flatMap(([name, files]) => files.length === 0 ? [] : [[name, total(files), files] as [string, number, { url: string, bytes: number }[]]]),
    ]
    const bytes = rows.reduce((sum, [, size]) => sum + size, 0)
    const longest = Math.max(...rows.map(([, bytes]) => bytes))

    for (const [name, bytes, files] of rows) {
      const track = tool.make('span', 'bars')
      const fill = tool.make('i')

      fill.style.width = `${longest === 0 ? 0 : Math.max(1, bytes / longest * 100)}%`
      track.append(fill)
      grid.append(tool.make('span', '', name), track, tool.make('span', 'v', formatBytes(bytes)))

      if (files.length > 0)
        grid.append(tool.make('span', 'files', files.map(file => `${file.url} ${formatBytes(file.bytes)}`).join(', ')))
    }

    grid.append(tool.make('span', 'rule'), tool.make('span', 'total', 'Total'), tool.make('span'), tool.make('span', 'v total', formatBytes(bytes)))
    weightPanel.replaceChildren(tool.make('h3', 'heading', 'Weight, compressed'), grid, tool.make('div', 'note', 'Dev sizes: not minified and with the dev-only code, so `kay build` makes them smaller.'))

    const [footprint, built] = await Promise.all([pageFootprint(tool.kit, doc.defaultView!, weight, bytes), builtSizes(tool.kit, doc.defaultView!)])

    if (ask !== asked)
      return

    if (footprint === undefined) {
      footprintPanel.replaceChildren(tool.make('h3', 'heading', 'Footprint of the page'), tool.make('div', 'note', 'The server did not answer with the EcoIndex and the carbon of the page.'))
    }
    else {
      const facts = tool.make('dl', 'facts')
      const fact = (term: string, ...values: (Node | string)[]) => {
        const value = tool.make('dd')

        value.append(...values)
        facts.append(tool.make('dt', '', term), value)
      }

      fact('EcoIndex', pill(footprint.grade, GRADE_TONES[footprint.grade as keyof typeof GRADE_TONES] ?? 'error'), `${footprint.score} of 100`)
      fact('Carbon', `${footprint.co2.toFixed(footprint.co2 < 0.1 ? 3 : 2)} gCO2e per view`)
      fact('DOM elements', String(weight.dom))
      fact('Requests', String(weight.requests))
      footprintPanel.replaceChildren(tool.make('h3', 'heading', 'Footprint of the page'), facts, tool.make('div', 'note', `Measured in this browser, with the dev sizes above, so \`kay build\` reports a lighter page.${weight.unweighed === 0 ? '' : ` ${weight.unweighed} ${weight.unweighed === 1 ? 'request' : 'requests'} of unknown weight, not counted.`} EcoIndex ${footprint.ecoindex}, Sustainable Web Design v${footprint.swd}.`))
    }

    if (built === undefined)
      return

    const production = tool.make('div', 'build')
    const mark = built.estimated ? '~' : ''
    const figure = (name: string, bytes: string) => {
      const element = tool.make('span', '', `${name} `)

      element.append(tool.make('b', '', bytes))

      return element
    }

    production.append(tool.make('span', '', `Last kay build, ${ago(Date.now() - built.built)}`), figure('JS', `${mark}${formatBytes(built.js)}`), figure('CSS', formatBytes(built.css)))
    weightPanel.append(production, tool.make('div', 'note', `Route ${built.route}, ${built.exported ? 'static export' : 'server build'}, gzipped, minified and without the dev-only code${built.estimated ? '; ~ marks an estimate, as no page of the route was prerendered, the scripts being what its components can load' : ''}. Build again for sizes of the code as it is now.`))
  }

  reread = () => void reload()
  vitals.changed.push(renderVitals)

  // A page swap brings other HTML, styles and islands: the weight is measured again.
  const swaps = new MutationObserver(() => {
    if (tab.panel.hidden === false && !scheduled) {
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        reread()
      })
    }
  })

  swaps.observe(doc.head, { childList: true })
  signal.addEventListener('abort', () => swaps.disconnect())

  const vitalsSection = tool.make('section', 'group')

  vitalsSection.append(tool.make('h3', 'heading', 'Web Vitals of the page load'), vitalsPanel, loadNote)
  tab.panel.append(vitalsSection, footprintPanel, weightPanel)
  renderVitals()

  return () => reread()
}
