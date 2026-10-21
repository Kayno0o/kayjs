import type { DevError } from '../server/dev-errors'
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { KAY_DIR, testWorker } from '../build/assets'
import { routerPath } from '../server/base'
import { browse, browserPath } from '../test/browser'
import { readDevAddress } from './address'
import { mountedAt } from './base-proxy'
import { diffPngs } from './screenshot-diff'
import { checkSize, MAX_DIFF_PIXELS, MAX_HEIGHT, MAX_WIDTH, ShotRefusedError } from './screenshot-limits'

export const SCREENSHOTS_DIR = join(KAY_DIR, 'screenshots')
export const DEFAULT_WIDTHS = [375, 1280]
const DEFAULT_HEIGHT = 800

// A page gets this long to load and hydrate, then is shot as it stands, and this long to load its fonts and images once it is shown. Tests of a page that never settles shorten both.
export const shotLimits = { settleMs: 10_000, imageMs: 3000 }
// The whole shot, a page that hangs the browser included.
const SHOT_MS = 45_000
const REACH_MS = 10_000
// The whole preparation of a shot.
const PREPARE_MS = 8000

// Beyond this many files the oldest shots go, a shot being three.
export const MAX_FILES = 240
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\u0000-\u001F\u007F\\]/
const QUERY_OR_HASH = /[?#]/
const SAFE = /[a-z0-9-]/
const LEADING_SLASH = /^\//
// A lock file beside a page's shots while one `kay screenshot` replaces them, which another of the same page waits for; one older than this is a dead process's.
const LOCK = '.lock'
const LOCK_STALE_MS = 30_000
const LOCK_POLL_MS = 50
const HIDE_DEV_TOOL = 'kay-dev { display: none !important }'

export type Scheme = 'light' | 'dark'

export interface ShotOptions {
  widths?: number[] | undefined
  height?: number | undefined
  scheme?: Scheme | undefined
  fullPage?: boolean | undefined
  // The mount point of the site, `''` at the root of its host.
  base?: string | undefined
  // Cookies the page is opened with, to shoot one behind a session.
  cookies?: { name: string, value: string }[] | undefined
}

export interface Shot {
  width: number
  scheme: Scheme
  // The PNG, from the project's root.
  file: string
  // The image's size, which a full page makes taller than the window.
  size: { width: number, height: number }
  // Set when the page was taller than `MAX_HEIGHT`.
  cut?: boolean | undefined
  // Set when the shot before it is too large to compare with, so no diff was made.
  diffSkipped?: boolean | undefined
  // The shot before this one of the same page and size, and what changed since.
  previous?: string | undefined
  diff?: { file: string, changed: number, ratio: number, box?: { x: number, y: number, width: number, height: number } | undefined } | undefined
}

export interface ShotReport {
  url: string
  status: number
  shots: Shot[]
  // The page's console errors and uncaught exceptions, and why it did not settle.
  console: string[]
  // What `kay dev` listed for the page: errors it met answering it or an island met on it, and why the server failed to boot.
  problems: DevError[]
}

// The path a visitor types for the page, under the site's mount point, or why it is refused: only a path of the dev server itself is shot, never another host's.
export function pagePath(input: string, base = ''): string {
  if (!input.startsWith('/') || input.startsWith('//') || CONTROL.test(input))
    throw new ShotRefusedError(`a page is named by its path on the dev server, such as /about, not ${JSON.stringify(input)}`)

  for (const segment of input.split(QUERY_OR_HASH, 1)[0]!.split('/')) {
    let decoded: string

    try {
      decoded = decodeURIComponent(segment)
    }
    catch {
      throw new ShotRefusedError(`${JSON.stringify(input)} has a malformed percent escape`)
    }

    if (decoded === '..')
      throw new ShotRefusedError(`${JSON.stringify(input)} leaves the page's path with ${segment}`)
  }

  const pathname = input.split(QUERY_OR_HASH, 1)[0]!

  const mounted = base === '' || pathname === base || pathname.startsWith(`${base}/`) ? input : `${base}${input}`

  // The proxy takes the base off, and what is left must not read as a host.
  if (routerPath(mounted, base).startsWith('//'))
    throw new ShotRefusedError(`${JSON.stringify(input)} has a second slash after the base`)

  return mounted
}

// The file name of a page's shot, the page's path made of letters, digits and `-`, anything else as `_` and its hex, so two paths never share one.
export function shotName(path: string, width: number, scheme: Scheme, height: number | undefined, fullPage: boolean): string {
  let slug = ''

  // The root has a name no path can have, as `/index` is a page of its own; capitals are escaped too, for a filesystem that ignores case.
  for (const byte of new TextEncoder().encode(path.replace(LEADING_SLASH, ''))) {
    const char = String.fromCharCode(byte)

    slug += SAFE.test(char) ? char : `_${byte.toString(16).padStart(2, '0')}`
  }

  if (slug === '')
    slug = '_root'

  if (slug.length > 100)
    slug = `${slug.slice(0, 80)}~${Bun.hash(path).toString(16)}`

  return `${slug}.${width}${height === undefined ? '' : `x${height}`}.${scheme}${fullPage ? '.full' : ''}`
}

// Shoots a page of the project's running `kay dev` at each width, keeping the shot before each for a diff.
export async function screenshot(root: string, input: string, options: ShotOptions = {}): Promise<ShotReport> {
  const widths = [...new Set(options.widths ?? DEFAULT_WIDTHS)].map(width => checkSize('--width', width, MAX_WIDTH))
  const height = options.height === undefined ? undefined : checkSize('--height', options.height, MAX_HEIGHT)
  const scheme = options.scheme ?? 'light'
  const path = pagePath(input, options.base)
  const origin = readDevAddress(root)

  if (origin === undefined)
    throw new ShotRefusedError('no `kay dev` is running in this project: start it, then shoot its pages')

  const mounted = options.base !== undefined && options.base !== '' ? mountedAt(origin, options.base) : undefined
  const served = mounted?.origin ?? origin

  try {
    const url = new URL(path, served)

    // The path was checked, so this holds; a path that moves the origin never reaches the browser.
    if (url.origin !== new URL(served).origin)
      throw new ShotRefusedError(`${JSON.stringify(input)} names another host than the dev server's`)

    const chromePath = process.env.BUN_CHROME_PATH

    if (browserPath() === undefined)
      throw new ShotRefusedError(`kay screenshot needs Chrome or Chromium, and none was found; install one, or give its path as BUN_CHROME_PATH${chromePath === undefined || chromePath === '' ? '' : ` (${chromePath} is none)`}`)

    const status = await reach(url)
    const report: ShotReport = { url: url.href, status, shots: [], console: [], problems: [] }

    for (const width of widths) {
      const open: { page?: { close: () => void } } = {}
      const taken = await within(shoot(open, root, url, path, width, height, scheme, options.fullPage === true, options.cookies ?? []), SHOT_MS)

      if (taken === undefined) {
        // The shot goes on in the background, its page closed rather than left to the end of the process.
        open.page?.close()

        throw new ShotRefusedError(`${url.href} was not shot within ${SHOT_MS / 1000} s at ${width} px, the browser stopped answering`)
      }

      report.shots.push(taken.shot)
      report.console.push(...taken.console.map(line => `${width} px: ${line}`))
    }

    report.problems = devProblems(root, routerPath(url.pathname, options.base ?? ''))

    return report
  }
  finally {
    mounted?.stop()
    prune(join(root, SCREENSHOTS_DIR))
  }
}

async function reach(url: URL): Promise<number> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(REACH_MS), redirect: 'follow' })).status
  }
  catch {
    throw new ShotRefusedError(`the dev server does not answer at ${url.origin}: it may be starting, or have stopped`)
  }
}

async function shoot(open: { page?: { close: () => void } }, root: string, url: URL, path: string, width: number, height: number | undefined, scheme: Scheme, fullPage: boolean, cookies: { name: string, value: string }[]): Promise<{ shot: Shot, console: string[] }> {
  const page = await browse(url.href, { width, height: height ?? DEFAULT_HEIGHT, timeout: `${shotLimits.settleMs}ms`, strict: false, lenient: true, colorScheme: scheme, cookies })

  open.page = page

  try {
    // The window is taller than the page's viewport by the browser's own bar.
    await page.view.cdp('Emulation.setDeviceMetricsOverride', { width, height: height ?? DEFAULT_HEIGHT, deviceScaleFactor: 1, mobile: false })
    // Through DevTools rather than the page's `evaluate`, which waits for a page still loading.
    const total = await within(prepare(page.view, fullPage), PREPARE_MS)
    const cut = fullPage && typeof total === 'number' && total > MAX_HEIGHT
    const clip = !fullPage || typeof total !== 'number' ? undefined : { x: 0, y: 0, width, height: Math.min(total, MAX_HEIGHT), scale: 1 }
    const { data } = await page.view.cdp<{ data: string }>('Page.captureScreenshot', { format: 'png', ...clip && { clip, captureBeyondViewport: true } })
    const png = Uint8Array.fromBase64(data)

    return { shot: await keep(root, shotName(path, width, scheme, height, fullPage), png, { width, scheme, cut }), console: [...page.errors] }
  }
  finally {
    page.close()
  }
}

// Hides kay's dev tool, which is a badge over the page that a diff would see move, waits for the fonts and images the window shows and answers the page's height. Best effort: a page that hangs the browser is shot as it stands.
async function prepare(view: Bun.WebView, fullPage: boolean): Promise<number | undefined> {
  const expression = `(async () => {
    const style = document.createElement('style')
    style.textContent = ${JSON.stringify(HIDE_DEV_TOOL)}
    document.head.append(style)
    if (${fullPage})
      for (const image of document.querySelectorAll('img[loading=lazy]')) image.setAttribute('loading', 'eager')
    const loading = [...document.images].filter(image => !image.complete).map(image => new Promise(resolve => {
      image.addEventListener('load', resolve)
      image.addEventListener('error', resolve)
      setTimeout(resolve, ${shotLimits.imageMs})
    }))
    await Promise.race([Promise.all([document.fonts.ready, ...loading]), new Promise(resolve => setTimeout(resolve, ${shotLimits.imageMs}))])
    return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
  })()`

  try {
    const { result } = await view.cdp<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })

    return typeof result.value === 'number' ? result.value : undefined
  }
  catch {
    return undefined
  }
}

// Runs `run` once no other `kay screenshot` replaces the same page's shots, which two at once would mix: one's previous shot would be the other's current.
export async function locked<T>(file: string, run: () => Promise<T>, staleMs = LOCK_STALE_MS): Promise<T> {
  const lock = `${file}${LOCK}`

  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })

      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        return run()

      takeOverStale(lock, staleMs)

      await Bun.sleep(LOCK_POLL_MS)
    }
  }

  const refresh = setInterval(() => {
    try {
      const now = new Date()

      utimesSync(lock, now, now)
    }
    catch {}
  }, staleMs / 3)

  try {
    return await run()
  }
  finally {
    clearInterval(refresh)
    rmSync(lock, { force: true })
  }
}

// Moves a stale lock aside by renaming it, which only one of several waiters seeing it can do, and puts it back when it turns out to be a fresh one taken since: linking it back leaves a lock a third process created in between alone. `now` is the clock.
export function takeOverStale(lock: string, staleMs: number, now = Date.now): void {
  try {
    const held = statSync(lock, { throwIfNoEntry: false })

    if (held === undefined || now() - held.mtimeMs <= staleMs)
      return

    const aside = `${lock}.${process.pid}.stale`

    renameSync(lock, aside)

    try {
      const moved = statSync(aside, { throwIfNoEntry: false })

      if (moved !== undefined && now() - moved.mtimeMs <= staleMs)
        linkSync(aside, lock)
    }
    finally {
      rmSync(aside, { force: true })
    }
  }
  catch {}
}

// Writes the shot beside the one before it, which becomes `.prev`, and the diff between them.
export async function keep(root: string, name: string, png: Uint8Array, shot: { width: number, scheme: Scheme, cut: boolean }): Promise<Shot> {
  const dir = join(root, SCREENSHOTS_DIR)

  mkdirSync(dir, { recursive: true })

  return locked(join(dir, name), async () => replace(dir, name, png, shot))
}

async function replace(dir: string, name: string, png: Uint8Array, shot: { width: number, scheme: Scheme, cut: boolean }): Promise<Shot> {
  const current = join(dir, `${name}.png`)
  const previous = join(dir, `${name}.prev.png`)
  const diff = join(dir, `${name}.diff.png`)
  const relative = (file: string) => join(SCREENSHOTS_DIR, file.slice(dir.length + 1))

  rmSync(diff, { force: true })

  let before: Uint8Array | undefined

  try {
    before = readFileSync(current)
    renameSync(current, previous)
  }
  catch {
    before = undefined
  }

  const partial = `${current}.${process.pid}`

  writeFileSync(partial, png)
  renameSync(partial, current)

  const { width, height } = await new Bun.Image(png).metadata()
  const kept: Shot = { width: shot.width, scheme: shot.scheme, file: relative(current), size: { width, height }, ...shot.cut && { cut: true } }

  if (before === undefined)
    return kept

  // Two decoded images and the canvas of the diff are held at once.
  let earlier: { width: number, height: number }

  try {
    earlier = await new Bun.Image(before).metadata()
  }
  // A shot before that is cut short or no PNG is as good as none.
  catch {
    return kept
  }

  if (Math.max(earlier.width * earlier.height, width * height) > MAX_DIFF_PIXELS)
    return { ...kept, diffSkipped: true }

  let compared: Awaited<ReturnType<typeof diffPngs>>

  try {
    compared = await diffPngs(before, png)
  }
  // A shot before that is cut short or no PNG is as good as none.
  catch {
    return kept
  }

  writeFileSync(diff, compared.image)

  return { ...kept, previous: relative(previous), diff: { file: relative(diff), changed: compared.changed, ratio: compared.ratio, box: compared.box } }
}

// The oldest files go once there are more than a few hundred, so a long session on a large site does not fill the disk.
export function prune(dir: string): void {
  let names: string[]

  try {
    names = readdirSync(dir).filter(name => !name.endsWith(LOCK))
  }
  catch {
    return
  }

  const files: { name: string, time: number }[] = []

  for (const name of names) {
    // A file another shot removed meanwhile is none.
    const stat = statSync(join(dir, name), { throwIfNoEntry: false })

    if (stat !== undefined)
      files.push({ name, time: stat.mtimeMs })
  }

  for (const { name } of files.toSorted((a, b) => b.time - a.time).slice(MAX_FILES))
    rmSync(join(dir, name), { force: true })
}

// What `kay dev` listed that concerns the page: its own requests and browser errors, and a failure to boot or compile, which concerns them all.
function devProblems(root: string, pathname: string): DevError[] {
  try {
    const { errors } = JSON.parse(readFileSync(join(root, KAY_DIR, `dev${testWorker()}`, 'errors.json'), 'utf8')) as { errors: DevError[] }

    return errors.filter(error => error.request === undefined || withoutSlash(error.request.path.split(QUERY_OR_HASH, 1)[0]!) === withoutSlash(pathname))
  }
  catch {
    return []
  }
}

// A trailing slash is the same page, which a redirect may add.
function withoutSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  const { promise: timedOut, resolve } = Promise.withResolvers<undefined>()
  const timer = setTimeout(resolve, ms)

  try {
    return await Promise.race([promise, timedOut])
  }
  finally {
    clearTimeout(timer)
  }
}
