import type { AxeResults } from '../runtime/dev-a11y'
import type { Duration } from '../runtime/duration'
import type { A11yViolation, BrowserOptions, DialogHandler, PageDialog, TestPage } from './page-types'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import process from 'node:process'
import { within } from '@kaynooo/utils/promise'
import { afterAll } from 'bun:test'
import { resolvePeer } from '../peers'
import { withUnreadable } from '../runtime/dev-a11y'
import { optionMs } from '../runtime/duration'
import { EAGER_ISLANDS } from '../runtime/markers'
import { installClock } from './clock'
import { createNetwork } from './network'
import { waitForText } from './text-match'

// A `Cookie` header, `name=value; other=value`, as a list; a value keeps any `=` after the first.
export function cookiePairs(cookies: BrowserOptions['cookies']): { name: string, value: string }[] {
  if (typeof cookies !== 'string')
    return cookies ?? []

  const pairs: { name: string, value: string }[] = []

  for (const piece of cookies.split(';')) {
    const at = piece.indexOf('=')
    const name = piece.slice(0, Math.max(at, 0)).trim()

    if (name !== '')
      pairs.push({ name, value: piece.slice(at + 1).trim() })
  }

  return pairs
}

// What kay logs in the browser for a problem it recovers from.
const KAY_PROBLEM = '[kay]'
// The headless shell is preferred: the same Blink and V8 with no browser UI, which holds far less memory than full Chrome.
const SHELLS = ['chrome-headless-shell', 'chromium-headless-shell']
const EXECUTABLES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']
const INSTALLED = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]
const TIMEOUT_MS = 5000
// How long the first load of a browser just started waits when the page's timeout is the default: Chrome starts its renderer and network service on it, which a CI host sharing its cores with a whole test run takes seconds over.
const COLD_LOAD_MS = 20_000
const POLL_MS = 25
// What `within` resolves with when the page did not answer in time.
const TIMED_OUT = Symbol('timed out')
// What a call of the page resolves with once its renderer crashed, after which Chrome answers none.
const CRASHED = Symbol('crashed')
// The files the page failed to load, such as the scripts that would hydrate its islands: refused, or a script answered as another type, which the browser does not run.
const FAILED_FILES = `performance.getEntriesByType('resource').flatMap(entry => { const path = new URL(entry.name).pathname; return entry.responseStatus >= 400 ? [path + ' answered ' + entry.responseStatus] : (path.endsWith('.js') || path.endsWith('.mjs')) && entry.contentType && !entry.contentType.includes('javascript') ? [path + ' answered as ' + entry.contentType] : [] })`
const FAILED_WAIT_MS = 1000
const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
}

// What Bun says of a Chrome that did not start or exited under it, which a page's own errors never begin with.
const START_FAILED = /^(?:Failed to spawn Chrome|Chrome process |Chrome exited)/

// How long one try of a click waits for its element to be actionable before the page scrolls it into place again, and what Bun's message for running out of it ends with.
const CLICK_WAIT_MS = 1000
const ACTIONABLE = /to be actionable$/
// What a navigation says when it is worth trying once more: the page navigated on its own meanwhile, as a dev server's live reload does, or the host's network changed under it.
const RETRIED = /navigated or closed|ERR_NETWORK_CHANGED/
// How long a click or a hover waits for a loading page to finish before it scrolls: a page that never finishes, as with a stalled image, is acted on after it.
const LOAD_WAIT_MS = 1000
// How a click scrolls the element into the view in turn, for one covered where another alignment puts it, such as under a fixed bar.
const ALIGNMENTS = ['center', 'end', 'start', 'nearest']
// The points of an element's box a click may aim at, as the fractions of its width and height: the middle first.
const POINTS = [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5]]
// What the message of a wait that ran out of time starts with.
const UNSETTLED = 'kay: timed out after'
// Loaded, for a page with JavaScript off, which hydrates no island.
const LOADED = `document.readyState === 'complete'`

// Loaded, no page swap in flight, and every island hydrating on load done: `_$k` is set on an island once hydrated.
const SETTLED = `document.readyState === 'complete' && !document.documentElement.hasAttribute('aria-busy') && [...document.querySelectorAll('${EAGER_ISLANDS}')].every(island => island._$k)`

// What kay makes for the Chrome of a process, named after it so a later run removes what a killed one left.
const OWNED = /^kay-chrome-(\d+)-/
// The profile Bun makes for Chrome even when given another, left empty then, in the temp directory.
const BUN_PROFILE = /^--user-data-dir=(.+\.bun-chrome)$/
const BUN_DIR = /^\.[\w-]+\.bun-chrome$/
// Chrome's lock, beside the profile, which a killed Chrome leaves.
const SINGLETON = /^org\.chromium\.Chromium\./
const FETCHER = /^org\.chromium\.Chromium\.chromium_chrome_url_fetcher_\./
// Where a rewritten command line goes from one argument to the next: a space before a flag.
const JOINED_FLAG = / (?=--)/
// How many times a browser process is looked for, a poll apart, when Bun launched Chrome and /proc may not list it yet.
const LAUNCH_LOOKS = 10
// A Chrome or Chromium executable, as /proc names it.
const CHROME = /chrom/i
// Chrome's crash handler, which outlives it on the temp directory it started with, Alpine's among them, but makes nothing there.
const CRASH_HANDLER = /crashpad/
// Where the owned directory notes the profile Bun made.
const BUN_RECORD = 'bun-profile'
// Chrome's lock names its host and process.
const LOCK_PID = /-(\d+)$/
// The parent's process in a /proc stat line, read from the end of the command's name.
const STAT_PARENT = /^\) \S (\d+)/
const EXIT_WAIT_MS = 5000
// Two animation frames: the first paint has happened.
// The wait ends in the page itself after a second, as a tab that paints no frame would leave the call pending.
const PAINTED = 'new Promise(resolve => { setTimeout(resolve, 1000); requestAnimationFrame(() => requestAnimationFrame(resolve)) })'
// How long the browser outlives its last page, for the next test's and for a pause between a file's tests (a server booting in a beforeAll). Past it, a run that closes nothing after each file does not keep an idle Chrome to its end.
const IDLE_MS = 5 * 60_000
// How many pages a browser opens before the next one, once none is open, starts another: Chrome keeps the renderer of a page it closed for as long as it runs, from 80 MB for a light page to 800 MB for an admin screen, so a file opening a page per test holds them all, and a page that failed to load as well.
const RECYCLE_AFTER = 3
// The connections Chrome opens to one host over HTTP/1.1.
const MAX_HOST_CONNECTIONS = 6
// What a page's origin keeps in the browser, cleared before each page.
const STORAGE_TYPES = 'cookies,local_storage,indexeddb,cache_storage,service_workers,file_systems,shared_storage,storage_buckets'

interface BrowserState { dir: string, pages: number, views: number, ready: Promise<void>, idle?: Timer, launched?: boolean, warm?: boolean }

// The browser of this process's pages. Bun runs one Chrome for every view and leaves the profile it gives it in the temp directory, so kay gives it one of its own and removes it once the browser closes.
let browser: BrowserState | undefined
// The process of the Chrome the last close killed: Bun spawns another only once it reaped that one, and fails a view made sooner.
let killed: number | undefined
let exitHooked = false

// bun test runs no exit handler, so the browser closes after the tests: after the whole run, or each file of a parallel one, from a preload such as kay/test/preload, else after the file that loaded kay/test first.
try {
  afterAll(closeBrowser)
}
catch {}

// A navigation made again once when it failed for a reason RETRIED names, unless the page is gone.
export async function retriedOnce(navigate: () => Promise<void>, gone: () => boolean): Promise<void> {
  try {
    await navigate()
  }
  catch (error) {
    if (gone() || !RETRIED.test(error instanceof Error ? error.message : String(error)))
      throw error

    await navigate()
  }
}

// The browser pages are opened in, or undefined when there is none: for `describe.skipIf(browserPath() === undefined)`.
export function browserPath(path?: string): string | undefined {
  const given = path ?? process.env.BUN_CHROME_PATH

  if (given !== undefined && given !== '')
    return existsSync(given) ? given : Bun.which(given) ?? undefined

  for (const name of SHELLS) {
    const found = Bun.which(name)

    if (found !== null && found !== '')
      return found
  }

  const shell = playwrightShell()

  if (shell !== undefined)
    return shell

  for (const name of EXECUTABLES) {
    const found = Bun.which(name)

    if (found !== null && found !== '')
      return found
  }

  return INSTALLED.find(file => existsSync(file))
}

// `PLAYWRIGHT_BROWSERS_PATH`, where `0` is Playwright's own word for the browsers it installed inside its package in `node_modules`.
function playwrightBrowsers(from: string): string | undefined {
  const given = process.env.PLAYWRIGHT_BROWSERS_PATH

  if (given !== '0')
    return given

  for (const name of ['playwright-core', '@playwright/test', 'playwright']) {
    const manifest = attempt(() => Bun.resolveSync(`${name}/package.json`, from))

    if (manifest !== undefined)
      return join(dirname(manifest), '.local-browsers')
  }

  return undefined
}

// The newest chrome-headless-shell in Playwright's browser cache (`bunx playwright install chromium-headless-shell`), where it keeps one on each system.
export function playwrightShell(from = process.cwd()): string | undefined {
  const home = homedir()
  const roots = [
    playwrightBrowsers(from),
    join(home, '.cache', 'ms-playwright'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ]
  const glob = new Bun.Glob('chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell{,.exe}')

  for (const root of roots) {
    if (root === undefined || root === '' || !existsSync(root))
      continue

    // The highest build number first.
    const found = [...attempt(() => [...glob.scanSync({ cwd: root, absolute: true })]) ?? []].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]

    if (found !== undefined)
      return found
  }

  return undefined
}

// Opens `url` of a server already running in a headless Chrome, as a visitor with no cookies or storage for the site yet.
export async function browse(url: string, options: BrowserOptions = {}): Promise<TestPage> {
  const executable = browserPath(options.path)

  if (executable === undefined) {
    const given = options.path ?? process.env.BUN_CHROME_PATH

    throw new Error(given !== undefined && given !== '' ? `kay: no browser at ${given}` : 'kay: browser tests need Chrome or Chromium, and none was found; install one, or give its path as the `path` option or `BUN_CHROME_PATH`')
  }

  const timeout = options.timeout === undefined ? TIMEOUT_MS : optionMs(options.timeout, 'the browser timeout')
  const strict = options.strict ?? true
  const errors: string[] = []
  const warnings: string[] = []
  // How many of `errors` a call already looked through for kay's own.
  let seen = 0
  // Chrome refuses to run its sandbox as root, as in a CI container, whose small /dev/shm crashes its renderer.
  const rootArgv = process.getuid?.() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
  const { dir, first, claimed } = await claimBrowser()
  // Whether the next load is one of a browser still starting: every page opened before one has loaded counts, not only the page that started it.
  let cold = !claimed.warm
  // `--enable-automation` lets Chrome tell its command line, which names the profile Bun made.
  // `--site-per-process` gives chrome-headless-shell the out-of-process iframes desktop Chrome has, so a sandboxed frame stuck in a loop leaves its page answering.
  const argv = [...rootArgv, `--user-data-dir=${join(dir, 'profile')}`, '--enable-automation', '--site-per-process']
  let view: Bun.WebView

  try {
    view = new Bun.WebView({
      ...options.width === undefined ? {} : { width: options.width },
      ...options.height === undefined ? {} : { height: options.height },
      backend: { type: 'chrome', path: executable, argv, url: false },
      console: (type, ...args) => {
        if (type === 'error')
          errors.push(args.map(consoleText).join(' '))
        else if (type === 'warn' || type === 'warning')
          warnings.push(args.map(consoleText).join(' '))
      },
    })

    if (browser)
      browser.launched = true
  }
  catch (error) {
    releaseBrowser()

    throw startFailure(error, executable)
  }

  let closed = false
  let origin = new URL(url).origin
  // Settles once the page's renderer is gone, killed or out of memory: every call pending or made after it would wait forever.
  const { promise: crash, resolve: crashed } = Promise.withResolvers<typeof CRASHED>()
  let gone = false

  view.addEventListener('Inspector.targetCrashed', () => {
    gone = true
    crashed(CRASHED)
  })

  const crashError = () => new Error('kay: the page crashed, its renderer killed or out of memory, so the browser answers nothing more of it')
  // A call of the view, failing at once when the renderer crashed rather than at the test's timeout; one made after it, which Bun may refuse as another still pending, is not made.
  const live = async <T>(call: () => Promise<T>): Promise<T> => {
    if (gone)
      throw crashError()

    const answer = await Promise.race([crash, call()])

    if (answer === CRASHED)
      throw crashError()

    return answer
  }
  // A view runs one DevTools command at a time, so the page's own and a route's queue behind each other.
  let commands: Promise<void> = Promise.resolve()
  const cdp = async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const previous = commands
    const { promise, resolve } = Promise.withResolvers<void>()

    commands = promise

    return live(async () => {
      await previous

      try {
        return await view.cdp<T>(method, params)
      }
      finally {
        resolve()
      }
    })
  }
  // A view runs one `inView()` at a time, so the page's calls queue rather than fail when a test runs two at once.
  let queue = Promise.resolve()
  // The view's last `inView()`, which a wait that timed out leaves running: the next waits for it, up to the page's timeout, rather than fail as already pending.
  let evaluating: Promise<unknown> = Promise.resolve()

  const inView = async <T>(expression: string): Promise<T> => {
    const previous = evaluating
    const call = (async () => {
      await within(Promise.race([previous, crash]), timeout, TIMED_OUT)

      return live(async () => view.evaluate<T>(expression))
    })()

    evaluating = ended(call)

    return call
  }
  // Failing to wait for a frame, as a page that closes meanwhile does, is not the open's failure.
  const painted = async () => {
    try {
      await inView(PAINTED)
    }
    catch {}
  }

  const serial = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = queue
    const { promise, resolve } = Promise.withResolvers<void>()

    queue = promise

    try {
      await previous

      const result = await run()
      const problem = strict ? errors.slice(seen).find(error => error.startsWith(KAY_PROBLEM)) : undefined

      seen = errors.length

      if (problem !== undefined)
        throw new Error(`kay: the page reported a problem production would hide: ${problem.slice(KAY_PROBLEM.length).trimStart()}; open it with strict: false to allow it`)

      return result
    }
    finally {
      resolve()
    }
  }

  // The milliseconds of a call's own `timeout`, undefined for the page's.
  const waitMs = (value: Duration | undefined) => value === undefined ? undefined : optionMs(value, 'timeout')

  // Polls the page, reading an error as not yet: the page may be between two documents. `told` is the wait the error names, the call's whole budget when this poll has only what is left of it.
  const poll = async (expression: string, wanted: string, wait = timeout, told = wait) => {
    const until = Date.now() + wait
    // Why the last try failed, if it threw: a page swap in flight throws once, a condition naming a test variable every time.
    let failure: unknown

    // A try still running when the last ran out of time, which the next waits on rather than start another.
    let trying: Promise<unknown> | undefined

    for (;;) {
      try {
        trying ??= inView(expression)

        const answer = await within(trying, Math.max(until - Date.now(), 0), TIMED_OUT)

        if (answer !== TIMED_OUT) {
          trying = undefined

          const settled = Boolean(answer)

          if (settled)
            return

          failure = undefined
        }
      }
      catch (error) {
        if (gone)
          throw error

        trying = undefined
        failure = error
      }

      if (Date.now() > until)
        throw new Error(`${UNSETTLED} ${told}ms waiting for ${wanted}${failure === undefined ? '' : `, last throwing ${failure instanceof Error ? failure.message : String(failure)}`}`, failure === undefined ? undefined : { cause: failure })

      await Bun.sleep(POLL_MS)
    }
  }

  // Runs a wait, and gives a timeout the stack of the call the test made, which the polling's own stack does not reach.
  const atCaller = async (site: Error, run: () => Promise<void>) => {
    try {
      await run()
    }
    catch (error) {
      if (error instanceof Error && error.message.startsWith(UNSETTLED) && site.stack !== undefined)
        error.stack = `${error.name}: ${error.message}\n${site.stack.split('\n').slice(2).join('\n')}`

      throw error
    }
  }

  // Waits for the page to settle, naming the files it failed to load when it does not.
  const settle = async (expression: string, wanted: string, wait = timeout) => {
    try {
      await poll(expression, wanted, wait)
    }
    catch (error) {
      let failed: string[] | typeof TIMED_OUT = []

      try {
        failed = await within(inView<string[]>(FAILED_FILES), FAILED_WAIT_MS, TIMED_OUT)
      }
      catch {}

      if (Array.isArray(failed) && failed.length > 0 && error instanceof Error)
        throw new Error(`${error.message}; the page failed to load ${failed.join(', ')}`, { cause: error })

      throw error
    }
  }

  const ready = options.javaScript === false ? LOADED : SETTLED

  const traverse = async (step: string) => {
    const entry = await inView<string>('navigation.currentEntry.key')

    // `history`, not the view's own back and forward, which wait for a load a swapped page never fires. A page with JavaScript off loads the entry as a new document, which may end the script's own evaluation.
    try {
      await inView(`void ${step}`)
    }
    catch (error) {
      if (gone || !RETRIED.test(error instanceof Error ? error.message : String(error)))
        throw error
    }
    await settle(`navigation.currentEntry.key !== ${JSON.stringify(entry)} && ${ready}`, 'the page to settle')
  }

  let dialogs: DialogHandler | undefined
  let dialogsOn = false
  const answerDialog = async (dialog: PageDialog) => {
    try {
      const answer = await dialogs?.(dialog) ?? false

      await cdp('Page.handleJavaScriptDialog', { accept: answer !== false, ...typeof answer === 'string' ? { promptText: answer } : {} })
    }
    catch (error) {
      // A dialog left open stops the page, so a handler that failed dismisses it.
      try {
        await cdp('Page.handleJavaScriptDialog', { accept: false })
      }
      catch {}

      if (!gone && !closed)
        errors.push(`kay: answering a dialog failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // The middle of the element, two frames on when scripts run, once a scroll or a transition settled.
  const center = async (selector: string): Promise<[number, number]> => {
    const point = await inView<[number, number] | null>(script(async (target: string, frames: boolean) => {
      if (frames)
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

      const element = document.querySelector(target)

      if (element === null)
        return null

      const { left, top, width, height } = element.getBoundingClientRect()

      return [left + width / 2, top + height / 2]
    }, [selector, options.javaScript !== false]))

    // Gone since the call found it, as a list's bar goes with its hover or a render replaces the node.
    if (point === null)
      throw new Error(`kay: ${selector} is not found, waiting for it to be actionable`)

    return point
  }

  // The point `at` of the element, scrolled so it is in the view, in viewport pixels.
  const pointAt = async (selector: string, at: { x: number, y: number }): Promise<[number, number]> => {
    const point = await inView<[number, number] | null>(script((target: string, x: number, y: number) => {
      const element = document.querySelector(target)

      if (element === null)
        return null

      const place = () => {
        const { left, top } = element.getBoundingClientRect()

        return [left + x, top + y] as [number, number]
      }
      const [px, py] = place()

      if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight)
        scrollBy({ left: px - innerWidth / 2, top: py - innerHeight / 2, behavior: 'instant' })

      return place()
    }, [selector, at.x, at.y]))

    // Gone since the click found it, as a list's bar goes with its hover or a render replaces the node: a click tries again.
    if (point === null)
      throw new Error(`kay: ${selector} is not found, waiting for it to be actionable`)

    return point
  }

  // Where a click reaches the element: scrolled to each alignment in turn, the point of its box that nothing covers first at the middle and then nearer each side, and whether it is the middle. What keeps a click from reaching it (nothing drawn, another element over every point) comes back as a reason instead.
  // The element is waited on for stillness once, at the alignment where a point reaches it, as Bun's own click does for the middle: its box must stay put across two frames, and the point is found again where it stopped.
  const reach = async (selector: string) => inView<[number, number, boolean] | string>(script(reachable, [selector, options.javaScript !== false, ALIGNMENTS, POINTS]))

  // Waits once for a loading page, before a click or hover scrolls, as the browser restoring a reload's scroll position until then would move the page away from the place a press is aimed at. A page that never finishes is acted on after the bound.
  const untilLoaded = async () => {
    try {
      await within(inView(script(loaded, [LOAD_WAIT_MS])), LOAD_WAIT_MS + POLL_MS, TIMED_OUT)
    }
    catch (error) {
      // A page replaced while waiting is the next try's to find.
      if (gone)
        throw error
    }
  }

  const network = createNetwork({ view, cdp, origin: () => origin, errors, timeout })
  const page: TestPage = {
    view,
    cdp,
    errors,
    warnings,
    responses: network.responses,
    waitForResponse: network.waitForResponse,
    route: network.route,
    unroute: network.unroute,
    offline: async () => serial(async () => network.offline(true)),
    online: async () => serial(async () => network.offline(false)),
    advance: async duration => serial(async () => {
      await inView(`window.__kayAdvance(${optionMs(duration, 'advance')})`)
    }),
    initScript: async (run, ...args) => serial(async () => {
      await cdp('Page.addScriptToEvaluateOnNewDocument', { source: script(run, args) })
    }),
    hover: async (selector, { at, ...wait } = {}) => serial(async () => {
      await untilLoaded()
      await poll(script(scrolledTo, [selector, true]), selector, waitMs(wait.timeout))

      const [x, y] = at === undefined ? await center(selector) : await pointAt(selector, at)

      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    }),
    tap: async (selector, { at, ...wait } = {}) => serial(async () => {
      await untilLoaded()
      await poll(script(scrolledTo, [selector, true]), selector, waitMs(wait.timeout))

      const [x, y] = at === undefined ? await center(selector) : await pointAt(selector, at)

      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }),
    drag: async (from, to, { at, to: toAt, steps = 8, hold = 0, ...wait } = {}) => serial(async () => {
      if (!Number.isInteger(steps) || steps < 1)
        throw new Error(`kay: drag steps must be a whole number of at least 1, got ${steps}`)

      await untilLoaded()
      await poll(script(scrolledTo, [from, true]), from, waitMs(wait.timeout))

      const [x, y] = at === undefined ? await center(from) : await pointAt(from, at)
      const touch = hold > 0
      const send = async (type: 'down' | 'move' | 'up', px: number, py: number) => {
        if (touch)
          await cdp('Input.dispatchTouchEvent', { type: { down: 'touchStart', move: 'touchMove', up: 'touchEnd' }[type], touchPoints: type === 'up' ? [] : [{ x: px, y: py }] })
        else
          await cdp('Input.dispatchMouseEvent', { type: { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[type], x: px, y: py, button: 'left', buttons: type === 'up' ? 0 : 1, clickCount: type === 'move' ? 0 : 1 })
      }

      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await send('down', x, y)

      let released = false
      let last = [x, y]

      try {
        if (touch)
          await Bun.sleep(hold)

        // The target is found once the pointer is down, as scrolling it into view may move the source away from where the pointer is.
        await poll(script(scrolledTo, [to, true]), to, waitMs(wait.timeout))

        const [tx, ty] = toAt === undefined ? await center(to) : await pointAt(to, toAt)

        for (let step = 1; step <= steps; step++) {
          last = [x + ((tx - x) * step / steps), y + ((ty - y) * step / steps)]
          await send('move', last[0]!, last[1]!)
        }

        released = true
        await send('up', tx, ty)
      }
      finally {
        // A drag that failed on the way leaves no button held down.
        if (!released) {
          try {
            await send('up', last[0]!, last[1]!)
          }
          catch {
            // The failure that ended the drag is the one reported.
          }
        }
      }
    }),
    goto: async path => serial(async () => {
      const target = new URL(path, origin)

      origin = target.origin

      const navigate = async () => retriedOnce(async () => live(async () => view.navigate(target.href)), () => gone)

      // The first load of a browser kay just started is allowed longer than the timeout kay/test defaults to, which a later load, and a timeout the test chose, are not.
      const budget = cold && options.timeout === undefined ? COLD_LOAD_MS : timeout

      const until = Date.now() + budget

      cold = false

      // A page that does not finish loading, a stalled image holding its load event, is not waited on past the budget.
      if (await within(navigate(), budget, TIMED_OUT) === TIMED_OUT)
        throw new Error(`${UNSETTLED} ${budget}ms waiting for ${target.pathname} to load${heldConnections()}`)

      // Its renderer has started, so the pages that open from now on are no longer cold.
      claimed.warm = true

      await settle(ready, `${target.pathname} to load and hydrate its islands`, Math.max(until - Date.now(), timeout))
    }),
    path: async () => serial(async () => inView<string>('location.pathname + location.search')),
    click: async (selector, { modifiers, at: aim, ...wait } = {}) => serial(async () => {
      await untilLoaded()

      const budget = waitMs(wait.timeout) ?? timeout
      const until = Date.now() + budget
      // Why the last try could not click, which a budget running out on the next scroll reports rather than the scroll's own wait.
      let refused: Error | undefined

      // Bun's click waits for the element in view without scrolling to it. Centered, so a fixed header or bar does not cover it; at once, so a smooth scroll does not keep it moving. Scrolled again between short waits, as a page restoring its scroll once loaded moves it away. An island not hydrated yet replays the click once it is.
      for (;;) {
        try {
          await poll(script(scrolledTo, [selector, false]), selector, Math.max(until - Date.now(), 1), budget)
        }
        catch (error) {
          throw refused !== undefined && error instanceof Error && error.message.startsWith(UNSETTLED) ? refused : error
        }

        const tried = Date.now()

        try {
          const at = aim === undefined ? await reach(selector) : await pointAt(selector, aim)

          if (typeof at === 'string') {
            await Bun.sleep(POLL_MS)

            throw new Error(`kay: ${selector} is ${at}, waiting for it to be actionable`)
          }

          // Bun's click waits for the element with a script of its own, which a page with JavaScript off does not run, and aims at its middle.
          if (options.javaScript === false || !at[2])
            await live(async () => view.click(at[0], at[1], modifiers === undefined ? {} : { modifiers }))
          else
            await live(async () => view.click(selector, { timeout: Math.min(Math.max(until - Date.now(), 1), CLICK_WAIT_MS), ...modifiers === undefined ? {} : { modifiers } }))

          return
        }
        catch (error) {
          if (gone || !(error instanceof Error) || !(ACTIONABLE.test(error.message) || Date.now() - tried >= CLICK_WAIT_MS - POLL_MS) || Date.now() >= until)
            throw error

          refused = error
        }
      }
    }),
    fill: async (selector, text) => serial(async () => {
      // The field is waited on and focused in one script, as a render can replace it between two. A field of an island not hydrated yet is waited on too, as an island writing its state to the field as it mounts would wipe the text typed into the server's markup, which the events queued for replay do not restore.
      await poll(script((css: string, eager: string) => {
        const field = document.querySelector<HTMLInputElement>(css)

        if (field === null)
          return false

        const owner = field.closest<HTMLElement & { _$k?: boolean }>(eager)

        if (owner !== null && !owner._$k)
          return false

        field.focus()
        field.select()

        return true
      }, [selector, EAGER_ISLANDS]), selector)

      await live(async () => text === '' ? view.press('Delete') : view.type(text))
    }),
    upload: async (selector, files) => serial(async () => {
      const paths = (Array.isArray(files) ? files : [files]).map(file => resolvePath(file))

      for (const file of paths) {
        if (!existsSync(file))
          throw new Error(`kay: no file at ${file} to upload`)
      }

      await poll(`!!document.querySelector(${JSON.stringify(selector)})`, selector)

      const { result } = await cdp<{ result: { objectId: string } }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` })

      try {
        await cdp('DOM.setFileInputFiles', { objectId: result.objectId, files: paths })
      }
      finally {
        await cdp('Runtime.releaseObject', { objectId: result.objectId })
      }
    }),
    onDialog: async handler => serial(async () => {
      dialogs = handler

      if (dialogsOn)
        return

      await cdp('Page.enable')
      dialogsOn = true
      view.addEventListener('Page.javascriptDialogOpening', (event) => {
        const { type, message, defaultPrompt } = (event as MessageEvent<{ type: PageDialog['type'], message: string, defaultPrompt?: string }>).data

        void answerDialog({ type, message, defaultPrompt: defaultPrompt ?? '' })
      })
    }),
    type: async text => serial(async () => live(async () => view.type(text))),
    press: async (key, keyOptions) => serial(async () => live(async () => view.press(key, keyOptions))),
    text: async selector => serial(async () => inView<string | null>(script((css: string) => document.querySelector(css)?.textContent ?? null, [selector]))),
    value: async selector => serial(async () => inView<string | null>(script((css: string) => document.querySelector<HTMLInputElement>(css)?.value ?? null, [selector]))),
    count: async selector => serial(async () => inView<number>(script((css: string) => document.querySelectorAll(css).length, [selector]))),
    evaluate: async (run, ...args) => serial(async () => inView(script(run, args))),
    waitFor: async (selector, wait = {}) => atCaller(new Error('the call'), async () => serial(async () => waitForText({ poll, inView, selector, wait, timeout: waitMs(wait.timeout) }))),
    a11y: async selector => serial(async () => {
      // Injected again after each navigation, which drops it; through DevTools, which the page's CSP does not hold back.
      if (!await inView<boolean>('!!window.axe')) {
        const { exceptionDetails } = await cdp<{ exceptionDetails?: { text: string, exception?: { description?: string } } }>('Runtime.evaluate', { expression: await axeSource() })

        if (exceptionDetails)
          throw new Error(`kay: axe-core did not load in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
      }

      const violations = await inView<A11yViolation[] | null>(script(async (unreadable: typeof withUnreadable, context?: string) => {
        const { axe } = window as unknown as { axe: Axe }

        if (context !== undefined && document.querySelector(context) === null)
          return null

        // A dev server's own check may be running, and axe-core runs one at a time. This runs in the page, so it cannot reach an import such as utils' `sleep`.
        while (axe._running)
          await new Promise(resolve => setTimeout(resolve, 25))

        // Leaving out a dev server's dev tool.
        const results = await axe.run({ include: context === undefined ? document : [[context]], exclude: [['kay-dev']] }, { resultTypes: ['violations', 'incomplete'] })

        return unreadable(results).map(({ id, impact, help, helpUrl, tags, nodes }) => ({ id, impact, help, helpUrl, tags, nodes: nodes.map(node => ({ target: node.target.map(part => Array.isArray(part) ? part.join(' >>> ') : part).join(' '), html: node.html })) }))
      }, [withUnreadable, selector]))

      if (violations === null)
        throw new Error(`kay: nothing matches ${selector} to check`)

      return violations
    }),
    waitUntil: async (condition, wait = {}, ...args) => atCaller(new Error('the call'), async () => serial(async () => poll(script(condition, args), wait.what ?? 'the condition to hold', waitMs(wait.timeout)))),
    back: async () => serial(async () => traverse('history.back()')),
    forward: async () => serial(async () => traverse('history.forward()')),
    reload: async () => serial(async () => {
      await retriedOnce(async () => live(async () => view.reload()), () => gone)
      await settle(ready, 'the page to reload and hydrate its islands')
    }),
    close: () => {
      network.close()
      attempt(() => view.close())

      if (!closed)
        releaseBrowser()

      closed = true
    },
    // eslint-disable-next-line ts/require-await -- the interface returns a promise
    [Symbol.asyncDispose]: async () => page.close(),
  }

  // Once open, a page is the caller's to close; one that failed to open is closed here.
  try {
    // A blank page first: the DevTools session the next calls use starts with a navigation.
    await live(async () => view.navigate('about:blank'))

    if (first)
      await noteBunProfile(view, dir)

    await cdp('Runtime.enable')
    await cdp('Inspector.enable')
    await cdp('Network.enable')

    const media = [
      ...options.colorScheme === undefined ? [] : [{ name: 'prefers-color-scheme', value: options.colorScheme }],
      ...options.reducedMotion === undefined ? [] : [{ name: 'prefers-reduced-motion', value: options.reducedMotion }],
    ]

    if (media.length > 0)
      await cdp('Emulation.setEmulatedMedia', { features: media })

    if (options.viewport !== undefined) {
      const { width, height, deviceScaleFactor = 1, mobile = false } = typeof options.viewport === 'string' ? VIEWPORTS[options.viewport] : options.viewport

      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile })
    }

    if (options.javaScript === false)
      await cdp('Emulation.setScriptExecutionDisabled', { value: true })
    else
      await cdp('Page.addScriptToEvaluateOnNewDocument', { source: script(installClock, []) })

    view.addEventListener('Runtime.exceptionThrown', (event) => {
      const { exceptionDetails } = (event as MessageEvent<{ exceptionDetails: { text: string, exception?: { description?: string } } }>).data

      errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text)
    })
    // Pages share one browser, whose cookies and storage outlive a page. Named one by one, as `all` takes Chrome 2 to 5 s a page, the rest under a millisecond.
    await cdp('Storage.clearDataForOrigin', { origin, storageTypes: STORAGE_TYPES })

    for (const { name, value } of cookiePairs(options.cookies))
      await cdp('Network.setCookie', { name, value, url: origin, path: '/' })

    try {
      await page.goto(url)

      // A browser just started has painted no frame by then, and a layout shift or a paint before the first one is not counted by the page's observers.
      if (options.javaScript !== false)
        await painted()
    }
    catch (error) {
      if (options.lenient !== true || !(error instanceof Error) || !error.message.startsWith(UNSETTLED))
        throw error

      errors.push(error.message)
    }
  }
  catch (error) {
    // The profile Bun made is noted while the browser still answers, should the blank page have failed.
    if (first)
      await within(noteBunProfile(view, dir), timeout, TIMED_OUT)

    page.close()

    throw first ? startFailure(error, executable) : error
  }

  return page
}

// A browser that did not start, or exited as it did, names the executable kay chose, as the cause is often that build rather than the page.
export function startFailure(error: unknown, executable: string): unknown {
  if (!(error instanceof Error) || !START_FAILED.test(error.message))
    return error

  return new Error(`${error.message} (browser: ${executable})`, { cause: error })
}

// What a load that stalls says of the pages left open: a browser holds six connections to a host, and a page following a live value keeps one open for as long as the page lives, so the seventh page waits for a connection none will give.
function heldConnections(): string {
  const others = (browser?.pages ?? 1) - 1

  return others < MAX_HOST_CONNECTIONS ? '' : `; ${others} other pages are still open, and a browser holds only ${MAX_HOST_CONNECTIONS} connections to a host, which a page following a live value keeps open until it is closed: close the pages a test is done with, as \`await using page = await site.open(...)\` does`
}

// A share of the browser for a page, the directory kay owns for it, and whether this page starts the browser.
async function claimBrowser(): Promise<{ dir: string, first: boolean, claimed: BrowserState }> {
  // Nothing is open, so closing the browser costs no page, and frees the renderers of the pages it has closed.
  if (browser && browser.pages === 0 && browser.views >= RECYCLE_AFTER)
    closeBrowser()

  if (browser) {
    clearTimeout(browser.idle)
    browser.pages++
    browser.views++
    await browser.ready

    return { dir: browser.dir, first: false, claimed: browser }
  }

  sweepProfiles()
  browser = { dir: mkdtempSync(join(tmpdir(), `kay-chrome-${process.pid}-`)), pages: 1, views: 1, ready: killed === undefined ? Promise.resolve() : exited(killed) }
  killed = undefined

  if (!exitHooked)
    process.on('exit', closeBrowser)

  exitHooked = true
  await browser.ready

  return { dir: browser.dir, first: true, claimed: browser }
}

// Closes the browser now when no page is open, for a server that drew a card and runs no test, rather than leave Chrome idle for minutes.
export function releaseIdleBrowser() {
  if (browser && browser.pages === 0)
    closeBrowser()
}

// A while after the last page closed, the browser goes with its profile, and the next page starts another.
function releaseBrowser() {
  if (!browser || --browser.pages > 0)
    return

  const idle = browser

  idle.idle = setTimeout(() => {
    if (browser === idle)
      closeBrowser()
  }, IDLE_MS)
  idle.idle.unref()
}

// Pages still open close with it. It never throws, running from a page's close and at exit.
function closeBrowser() {
  if (!browser)
    return

  const { dir, idle, launched } = browser
  const pid = LOCK_PID.exec(attempt(() => readlinkSync(join(dir, 'profile', 'SingletonLock'))) ?? '')?.[1] ?? browserProcess(join(dir, 'profile'), launched ? LAUNCH_LOOKS : 1)
  // Read before Chrome is killed, which hands what it started to another parent.
  const tree = pid === undefined ? [] : chromeTree(Number(pid), join(dir, 'profile'))

  browser = undefined
  clearTimeout(idle)
  // Closing the views leaves Chrome running, and would leave it writing to the profile.
  attempt(() => Bun.WebView.closeAll())
  killed = pid === undefined ? undefined : Number(pid)
  // Some Chrome's processes outlive it, Alpine's among them, and would write the profile again once removed; so would one Chrome started after the tree was read, which names the profile too.
  killAll(tree)
  killAll(naming(join(dir, 'profile')))
  attempt(() => removeProfile(dir))
  removeFetcherDirs()
}

// The directory kay owns, Chrome's lock beside the profile, which a killed Chrome leaves, and the empty profile Bun made, each only where it is directly in the temp directory, whatever a killed run's files say.
function removeProfile(dir: string) {
  const socket = attempt(() => readlinkSync(join(dir, 'profile', 'SingletonSocket')))
  const lock = socket === undefined ? undefined : dirname(socket)

  if (lock !== undefined && SINGLETON.test(basename(lock)) && inTemp(lock))
    rmSync(lock, { recursive: true, force: true })

  const bun = attempt(() => readFileSync(join(dir, BUN_RECORD), 'utf8'))

  // Only while empty: a Chrome the app's own view started runs on Bun's.
  if (bun !== undefined && BUN_DIR.test(basename(bun)) && inTemp(bun))
    attempt(() => rmdirSync(bun))

  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

// Chrome's process and every one it started, read from /proc, none where there is no /proc or the process does not name the profile kay gave it: a process that took the number of one that crashed is left alone.
export function chromeTree(pid: number, profile: string): number[] {
  if (argvOf(pid)?.includes(`--user-data-dir=${profile}`) !== true)
    return []

  const tree = [pid]
  const children = new Map<number, number[]>()

  for (const name of attempt(() => readdirSync('/proc')) ?? []) {
    const stat = attempt(() => readFileSync(`/proc/${name}/stat`, 'utf8'))

    // The parent follows the state, after the command's name, which may hold spaces and parentheses.
    const parent = stat === undefined ? undefined : STAT_PARENT.exec(stat.slice(stat.lastIndexOf(')')))?.[1]

    if (parent !== undefined)
      children.set(Number(parent), [...children.get(Number(parent)) ?? [], Number(name)])
  }

  // Each child found is visited in turn, as it joins the tree.
  for (const member of tree)
    tree.push(...children.get(member) ?? [])

  return tree
}

// A process's command line from /proc, the arguments apart. chrome-headless-shell rewrites its own into one entry of arguments joined by spaces, which is cut before each flag, so an executable or a profile whose path holds a space stays one argument.
export function argvOf(pid: number | string): string[] | undefined {
  const argv = attempt(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8'))?.split('\0')

  return argv?.length === 2 && argv[1] === '' ? argv[0]?.split(JOINED_FLAG) : argv
}

// The browser process of a Chrome that writes no lock, as chrome-headless-shell does: the one running on the profile that is not a crash handler or a child (`--type=`). Bun spawns another Chrome only once the killed one is reaped, which `killed` tells it.
// A Chrome Bun just launched may not be listed yet, so `looks` tries, a poll apart, to find it.
export function browserProcess(profile: string, looks = 1): string | undefined {
  const flag = `--user-data-dir=${profile}`

  for (let look = 0; look < looks; look++) {
    if (look > 0)
      Bun.sleepSync(POLL_MS)

    const found = (attempt(() => readdirSync('/proc')) ?? []).find((name) => {
      const argv = argvOf(name)

      return argv?.[0] !== undefined && CHROME.test(basename(argv[0])) && !CRASH_HANDLER.test(basename(argv[0])) && argv.includes(flag) && !argv.some(arg => arg.startsWith('--type='))
    })

    if (found !== undefined)
      return found
  }

  return undefined
}

// The processes running on the profile, read from /proc: Chrome passes its profile to every process it starts.
function naming(profile: string): number[] {
  const flag = `--user-data-dir=${profile}`

  return (attempt(() => readdirSync('/proc')) ?? []).filter(name => argvOf(name)?.includes(flag) === true).map(Number)
}

// Kills the processes, waiting a moment for them to be gone.
export function killAll(tree: number[]): void {
  for (const member of tree)
    attempt(() => process.kill(member, 'SIGKILL'))

  const until = Date.now() + EXIT_WAIT_MS

  while (tree.some(running) && Date.now() < until)
    Bun.sleepSync(POLL_MS)
}

// Whether a process still runs, a zombie no longer writing anything.
function running(pid: number): boolean {
  const stat = attempt(() => readFileSync(`/proc/${pid}/stat`, 'utf8'))

  return stat !== undefined && stat[stat.lastIndexOf(')') + 2] !== 'Z'
}

// The empty directories some Chrome makes in the temp directory while it runs and leaves once killed, Alpine's among them, which name no process: removed once no Chrome runs on the temp directory, as far as /proc tells, so the last browser of parallel runs removes them all.
export function removeFetcherDirs(): void {
  const temp = attempt(() => realpathSync(tmpdir()))

  if (temp === undefined || !existsSync('/proc') || chromeRunsIn(temp))
    return

  for (const name of attempt(() => readdirSync(tmpdir())) ?? []) {
    if (FETCHER.test(name))
      attempt(() => rmdirSync(join(tmpdir(), name)))
  }
}

// Whether the browser process of a Chrome runs with this temp directory; another user's tells nothing, its directories not this one's to remove.
function chromeRunsIn(temp: string): boolean {
  return (attempt(() => readdirSync('/proc')) ?? []).some((name) => {
    const argv = argvOf(name)

    if (argv?.[0] === undefined || !CHROME.test(basename(argv[0])) || CRASH_HANDLER.test(basename(argv[0])) || argv.some(arg => arg.startsWith('--type=')) || !running(Number(name)))
      return false

    const environ = attempt(() => readFileSync(`/proc/${name}/environ`, 'utf8'))?.split('\0')
    const set = environ?.find(variable => variable.startsWith('TMPDIR='))?.slice('TMPDIR='.length)
    const own = set === undefined || set === '' ? '/tmp' : set

    return environ !== undefined && attempt(() => realpathSync(own)) === temp
  })
}

// What the browsers of killed runs left, their process gone, as far as it can be removed: a directory another user owns stays.
function sweepProfiles() {
  for (const name of attempt(() => readdirSync(tmpdir())) ?? []) {
    const pid = OWNED.exec(name)?.[1]

    if (pid !== undefined && !alive(Number(pid)))
      attempt(() => removeProfile(join(tmpdir(), name)))
  }
}

// Chrome may name the temp directory through its links resolved.
function inTemp(path: string): boolean {
  const temp = attempt(() => realpathSync(tmpdir()))

  return temp !== undefined && attempt(() => realpathSync(dirname(path))) === temp
}

async function exited(pid: number) {
  const until = Date.now() + EXIT_WAIT_MS

  while (alive(pid) && Date.now() < until)
    await Bun.sleep(POLL_MS)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  }
  catch (error) {
    // Another user's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Chrome's command line names the profile Bun made for it, which kay's replaced; one the app's own view started without `--enable-automation` tells nothing.
async function noteBunProfile(view: Bun.WebView, dir: string) {
  try {
    const { arguments: argv } = await view.cdp<{ arguments: string[] }>('Browser.getBrowserCommandLine')
    const bun = argv.map(arg => BUN_PROFILE.exec(arg)?.[1]).find(found => found !== undefined)

    if (bun !== undefined)
      writeFileSync(join(dir, BUN_RECORD), bun)
  }
  catch {}
}

function attempt<T>(run: () => T): T | undefined {
  try {
    return run()
  }
  catch {
    return undefined
  }
}

interface Axe {
  _running?: boolean
  run: (context: unknown, options: unknown) => Promise<AxeResults<Omit<A11yViolation, 'nodes'> & { nodes: { target: (string | string[])[], html: string }[] }>>
}

let axe: string | undefined

// axe-core's browser build, read once where the app installed it; a plain error naming the install command when it did not.
async function axeSource(): Promise<string> {
  axe ??= await Bun.file(resolvePeer('axe-core', 'axe-core/axe.min.js')).text()

  return axe
}

// Runs in the page: the point of the element a click reaches, or why none does, as `reach` reads it.
async function reachable(target: string, frames: boolean, alignments: string[], points: number[][]): Promise<[number, number, boolean] | string> {
  const element = document.querySelector(target)

  // Gone since the click found it: a list's bar goes with its hover, a render replaces the node.
  if (element === null)
    return 'not found'

  let covered = 'out of view'

  const frame = async () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const box = () => {
    const { left, top, width, height } = element.getBoundingClientRect()

    return `${left},${top},${width},${height}`
  }
  // The first point of the box that reaches the element, or what covers the point tried first.
  const look = (): [number, number, boolean] | undefined => {
    const { left, top, width, height } = element.getBoundingClientRect()

    for (const [at, [across, down]] of points.entries()) {
      const x = left + width * across!
      const y = top + height * down!
      const over = document.elementFromPoint(x, y)

      if (over === null)
        continue

      if (element.contains(over))
        return [x, y, at === 0]

      if (covered === 'out of view') {
        const { tagName, id, classList } = over

        covered = `${tagName.toLowerCase()}${id === '' ? '' : `#${id}`}${classList.length === 0 ? '' : `.${classList[0]}`}`
      }
    }

    return undefined
  }

  for (const block of alignments) {
    element.scrollIntoView({ block: block as ScrollLogicalPosition, inline: 'center', behavior: 'instant' })

    if (element.getClientRects().length === 0)
      return 'not visible'

    let found = look()

    if (found === undefined)
      continue

    if (frames) {
      for (let tries = 0; tries < 30; tries++) {
        const before = box()

        await frame()

        if (box() === before)
          break
      }

      if (element.getClientRects().length === 0)
        return 'not visible'

      found = look()
    }

    if (found !== undefined)
      return found
  }

  return covered === 'out of view' ? covered : `covered by ${covered}`
}

// Runs in the page: scrolls the element to the middle; whether it is there, and drawn when `drawn`.
function scrolledTo(target: string, drawn: boolean): boolean {
  const element = document.querySelector(target)

  element?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })

  return element !== null && (!drawn || element.getClientRects().length > 0)
}

// Runs in the page: resolves once it loaded, or after `wait` ms.
async function loaded(wait: number): Promise<void> {
  if (document.readyState === 'complete')
    return

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, wait)

    addEventListener('load', () => {
      clearTimeout(timer)
      resolve(undefined)
    }, { once: true })
  })
}

// A call of `run` in the page, an undefined argument kept as such rather than sent as JSON's null.
// A function argument crosses as its source, so it must read nothing from its module.
function script(run: (...args: never[]) => unknown, args: unknown[]): string {
  return `(${run.toString()})(${args.map((arg) => {
    if (arg === undefined)
      return 'undefined'

    return typeof arg === 'function' ? arg.toString() : JSON.stringify(arg)
  }).join(', ')})`
}

// Resolves once `promise` settles, either way.
async function ended(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  }
  catch {}
}

// A console argument as text: an object arrives as DevTools describes it, an error with its stack.
function consoleText(arg: unknown): string {
  if (typeof arg !== 'object' || arg === null)
    return String(arg)

  const { description, value } = arg as { description?: string, value?: unknown }

  return description ?? JSON.stringify(value ?? arg)
}
