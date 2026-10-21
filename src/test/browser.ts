import type { AxeResults } from '../runtime/dev-a11y'
import type { Network, PageResponse } from './network'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'bun:test'
import { withUnreadable } from '../runtime/dev-a11y'
import { ISLAND } from '../runtime/markers'
import { createNetwork } from './network'

export interface BrowserOptions {
  // The Chrome or Chromium executable, else `BUN_CHROME_PATH`, else the first one found on the PATH or where it usually installs.
  path?: string | undefined
  width?: number | undefined
  height?: number | undefined
  // How long a page waits for an element, a condition or a navigation, in milliseconds.
  timeout?: number | undefined
  // The page's next call fails once it logs a problem kay recovers from in production, such as an island that did not match its server markup; `false` leaves it in `errors`.
  strict?: boolean | undefined
  // A page that does not settle within the timeout, loaded and hydrated, is returned as it stands with the reason in `errors`, instead of failing the call.
  lenient?: boolean | undefined
  // The colour scheme the page is asked for from its first load, `prefers-color-scheme` and `matchMedia` alike.
  colorScheme?: 'light' | 'dark' | undefined
  // The motion preference the page is asked for from its first load, `prefers-reduced-motion` and `matchMedia` alike.
  reducedMotion?: 'reduce' | 'no-preference' | undefined
  // `false` turns JavaScript off for the page, as a visitor who disabled it: its scripts never run, so a test sees what the server rendered, and `evaluate` and the waits still read the page.
  javaScript?: boolean | undefined
  // Cookies the page's first load carries, for a site's origin, such as a session's: a `Cookie` header string, as `auth.sessionCookie` returns, or a list.
  cookies?: string | { name: string, value: string }[] | undefined
}

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

export interface WaitOptions {
  timeout?: number | undefined
}

export interface ClickOptions extends WaitOptions {
  // Keys held down during the click, such as `['Alt']`.
  modifiers?: Bun.WebView.Modifier[] | undefined
}

export interface WaitForOptions extends WaitOptions {
  // Only an element whose text contains this.
  text?: string | undefined
  // Waits for no element to match instead.
  gone?: boolean | undefined
}

// A rule of axe-core the page breaks, and the elements breaking it.
export interface A11yViolation {
  // The rule, such as `color-contrast` or `label`.
  id: string
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null
  help: string
  // Where axe-core explains the rule and how to meet it.
  helpUrl: string
  // Each element's CSS selector and markup.
  nodes: { target: string, html: string }[]
}

// A dialog the page opened.
export interface PageDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  // A prompt's default text, else an empty string.
  defaultPrompt: string
}

export type DialogHandler = (dialog: PageDialog) => boolean | string | Promise<boolean | string>

export type { FetchedResponse, FulfillOptions, PageRequest, PageResponse, RouteHandler, RouteMatch } from './network'

export interface TestPage {
  // The `Bun.WebView` behind the page, for what the helpers leave out, such as `screenshot()` or `cdp()`.
  view: Bun.WebView
  // A DevTools command of the page, queued with the page's own: the view runs one at a time, so a raw `view.cdp()` made while a page call or a route runs fails as already pending.
  cdp: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  // The console errors and uncaught exceptions of the page so far.
  errors: string[]
  // The console warnings of the page so far.
  warnings: string[]
  // Loads a path of the site, or any URL, resolving once the page loaded and its eager islands hydrated.
  goto: (path: string) => Promise<void>
  // The current path and query, a swapped page's included.
  path: () => Promise<string>
  // Scrolls the element to the middle of the view and waits for it to be visible, still and not covered, then clicks it as a user does.
  click: (selector: string, options?: ClickOptions) => Promise<void>
  // Replaces a field's text with `text`, as typing it does, firing `input`.
  fill: (selector: string, text: string) => Promise<void>
  // Puts files in a file input, by path, as choosing them in the picker does, firing `input` and `change`.
  upload: (selector: string, files: string | string[]) => Promise<void>
  // Answers the page's `alert`, `confirm`, `prompt` and `beforeunload` dialogs, which otherwise stay open and stop the page: the handler returns `true` to accept, `false` to dismiss, or a string to accept a prompt with that text. A later call replaces the handler.
  onDialog: (handler: DialogHandler) => Promise<void>
  // Types into the focused element.
  type: (text: string) => Promise<void>
  press: (key: Parameters<Bun.WebView['press']>[0], options?: Parameters<Bun.WebView['press']>[1]) => Promise<void>
  // Moves the pointer onto the middle of the element, scrolled into view, and leaves it there.
  hover: (selector: string, options?: WaitOptions) => Promise<void>
  // The first match's text, or null when nothing matches.
  text: (selector: string) => Promise<string | null>
  // The first match's form value, or null when nothing matches.
  value: (selector: string) => Promise<string | null>
  count: (selector: string) => Promise<number>
  // Runs a function in the page, its arguments and result crossing as JSON. Only its source crosses: it sees no variable of the test, only its arguments.
  evaluate: <Args extends unknown[], Result>(run: (...args: Args) => Result | Promise<Result>, ...args: Args) => Promise<Result>
  waitFor: (selector: string, options?: WaitForOptions) => Promise<void>
  // Checks the page as it stands, or only the elements `selector` matches, with axe-core: what it breaks, none when it passes.
  a11y: (selector?: string) => Promise<A11yViolation[]>
  // Waits for a function run in the page, as `evaluate` runs it, to return something truthy.
  waitUntil: <Args extends unknown[]>(condition: (...args: Args) => unknown, options?: WaitOptions, ...args: Args) => Promise<void>
  // Every response the page received so far, redirects included, with its status and its request and response headers as the wire carried them, lowercased. A test empties the list with `responses.length = 0`.
  responses: PageResponse[]
  // Resolves with the first response whose URL matches, already received or not, once its body arrived (`complete: false` resolves on its headers, for one that never ends): a string with `*` for any characters, matched against the path on the page's site when it starts with `/`, else against the whole URL, a RegExp on the URL, or a function of the `URL`.
  waitForResponse: Network['waitForResponse']
  // Answers the requests matching, any the page makes from now on: the handler calls `fulfill`, `abort` or `continue` on the request, `fetch()` to get the server's answer first, and a request it answers none of goes on. The latest route matching a request answers it.
  route: Network['route']
  // Stops answering the requests a route given the same `match` matched, or every route without one.
  unroute: Network['unroute']
  // Cuts the page off the network, every request failing as with no connection, `navigator.onLine` false; `online()` restores it.
  offline: () => Promise<void>
  online: () => Promise<void>
  // Runs a function in every document the page loads from now on, before the document's own scripts, in each frame; its arguments cross as for `evaluate`.
  initScript: <Args extends unknown[]>(run: (...args: Args) => unknown, ...args: Args) => Promise<void>
  // Back and forward go through history, swapped pages included, resolving as `goto` does.
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  close: () => void
  [Symbol.asyncDispose]: () => Promise<void>
}

// What kay logs in the browser for a problem it recovers from.
const KAY_PROBLEM = '[kay]'
const EXECUTABLES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']
const INSTALLED = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]
const TIMEOUT_MS = 5000
const POLL_MS = 25
// What `within` resolves with when the page did not answer in time.
const TIMED_OUT = Symbol('timed out')
// What a call of the page resolves with once its renderer crashed, after which Chrome answers none.
const CRASHED = Symbol('crashed')
// The files the page failed to load, such as the scripts that would hydrate its islands: refused, or a script answered as another type, which the browser does not run.
const FAILED_FILES = `performance.getEntriesByType('resource').flatMap(entry => { const path = new URL(entry.name).pathname; return entry.responseStatus >= 400 ? [path + ' answered ' + entry.responseStatus] : (path.endsWith('.js') || path.endsWith('.mjs')) && entry.contentType && !entry.contentType.includes('javascript') ? [path + ' answered as ' + entry.contentType] : [] })`
const FAILED_WAIT_MS = 1000
// How long one try of a click waits for its element to be actionable before the page scrolls it into place again, and what Bun's message for running out of it ends with.
const CLICK_WAIT_MS = 1000
const ACTIONABLE = /to be actionable$/
// What a navigation says when the page navigated on its own meanwhile, as a dev server's live reload does.
const NAVIGATED = /navigated or closed/
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
const SETTLED = `document.readyState === 'complete' && !document.documentElement.hasAttribute('aria-busy') && [...document.querySelectorAll('${ISLAND}:not([data-hydrate=visible]):not([data-hydrate=idle])')].every(island => island._$k)`

// What kay makes for the Chrome of a process, named after it so a later run removes what a killed one left.
const OWNED = /^kay-chrome-(\d+)-/
// The profile Bun makes for Chrome even when given another, left empty then, in the temp directory.
const BUN_PROFILE = /^--user-data-dir=(.+\.bun-chrome)$/
const BUN_DIR = /^\.[\w-]+\.bun-chrome$/
// Chrome's lock, beside the profile, which a killed Chrome leaves.
const SINGLETON = /^org\.chromium\.Chromium\./
const FETCHER = /^org\.chromium\.Chromium\.chromium_chrome_url_fetcher_\./
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
// How long the browser outlives its last page, for the next test's and for a pause between a file's tests (a server booting in a beforeAll). Past it, a run that closes nothing after each file does not keep an idle Chrome to its end.
const IDLE_MS = 5 * 60_000
// The connections Chrome opens to one host over HTTP/1.1.
const MAX_HOST_CONNECTIONS = 6
// What a page's origin keeps in the browser, cleared before each page.
const STORAGE_TYPES = 'cookies,local_storage,indexeddb,cache_storage,service_workers,file_systems,shared_storage,storage_buckets'

// The browser of this process's pages. Bun runs one Chrome for every view and leaves the profile it gives it in the temp directory, so kay gives it one of its own and removes it once the browser closes.
let browser: { dir: string, pages: number, ready: Promise<void>, idle?: Timer } | undefined
// The process of the Chrome the last close killed: Bun spawns another only once it reaped that one, and fails a view made sooner.
let killed: number | undefined
let exitHooked = false

// bun test runs no exit handler, so the browser closes after the tests: after the whole run, or each file of a parallel one, from a preload such as kay/test/preload, else after the file that loaded kay/test first.
try {
  afterAll(closeBrowser)
}
catch {}

// The browser pages are opened in, or undefined when there is none: for `describe.skipIf(browserPath() === undefined)`.
export function browserPath(path?: string): string | undefined {
  const given = path ?? process.env.BUN_CHROME_PATH

  if (given !== undefined && given !== '')
    return existsSync(given) ? given : Bun.which(given) ?? undefined

  for (const name of EXECUTABLES) {
    const found = Bun.which(name)

    if (found !== null && found !== '')
      return found
  }

  return INSTALLED.find(file => existsSync(file))
}

// Opens `url` of a server already running in a headless Chrome, as a visitor with no cookies or storage for the site yet.
export async function browse(url: string, options: BrowserOptions = {}): Promise<TestPage> {
  const executable = browserPath(options.path)

  if (executable === undefined) {
    const given = options.path ?? process.env.BUN_CHROME_PATH

    throw new Error(given !== undefined && given !== '' ? `kay: no browser at ${given}` : 'kay: browser tests need Chrome or Chromium, and none was found; install one, or give its path as the `path` option or `BUN_CHROME_PATH`')
  }

  const timeout = options.timeout ?? TIMEOUT_MS
  const strict = options.strict ?? true
  const errors: string[] = []
  const warnings: string[] = []
  // How many of `errors` a call already looked through for kay's own.
  let seen = 0
  // Chrome refuses to run its sandbox as root, as in a CI container, whose small /dev/shm crashes its renderer.
  const rootArgv = process.getuid?.() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
  const { dir, first } = await claimBrowser()
  // `--enable-automation` lets Chrome tell its command line, which names the profile Bun made.
  const argv = [...rootArgv, `--user-data-dir=${join(dir, 'profile')}`, '--enable-automation']
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
  }
  catch (error) {
    releaseBrowser()

    throw error
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
      await within(Promise.race([previous, crash]), timeout)

      return live(async () => view.evaluate<T>(expression))
    })()

    evaluating = ended(call)

    return call
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

  // Polls the page, reading an error as not yet: the page may be between two documents.
  const poll = async (expression: string, wanted: string, wait = timeout) => {
    const until = Date.now() + wait
    // Why the last try failed, if it threw: a page swap in flight throws once, a condition naming a test variable every time.
    let failure: unknown

    // A try still running when the last ran out of time, which the next waits on rather than start another.
    let trying: Promise<unknown> | undefined

    for (;;) {
      try {
        trying ??= inView(expression)

        const answer = await within(trying, until - Date.now())

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
        throw new Error(`${UNSETTLED} ${wait}ms waiting for ${wanted}${failure === undefined ? '' : `, last throwing ${failure instanceof Error ? failure.message : String(failure)}`}`, failure === undefined ? undefined : { cause: failure })

      await Bun.sleep(POLL_MS)
    }
  }

  // Waits for the page to settle, naming the files it failed to load when it does not.
  const settle = async (expression: string, wanted: string) => {
    try {
      await poll(expression, wanted)
    }
    catch (error) {
      let failed: string[] | typeof TIMED_OUT = []

      try {
        failed = await within(inView<string[]>(FAILED_FILES), FAILED_WAIT_MS)
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

    // `history`, not the view's own back and forward, which wait for a load a swapped page never fires.
    await inView(`void ${step}`)
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
  const center = async (selector: string) => inView<[number, number]>(script(async (target: string, frames: boolean) => {
    if (frames)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    const { left, top, width, height } = document.querySelector(target)!.getBoundingClientRect()

    return [left + width / 2, top + height / 2]
  }, [selector, options.javaScript !== false]))

  // Where a click reaches the element: scrolled to each alignment in turn, the point of its box that nothing covers first at the middle and then nearer each side, and whether it is the middle. What keeps a click from reaching it (nothing drawn, another element over every point) comes back as a reason instead.
  // The element is waited on for stillness once, at the alignment where a point reaches it, as Bun's own click does for the middle: its box must stay put across two frames, and the point is found again where it stopped.
  const reach = async (selector: string) => inView<[number, number, boolean] | string>(script(async (target: string, frames: boolean, alignments: string[], points: number[][]) => {
    const element = document.querySelector(target)!
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
  }, [selector, options.javaScript !== false, ALIGNMENTS, POINTS]))

  // Waits once for a loading page, before a click or hover scrolls, as the browser restoring a reload's scroll position until then would move the page away from the place a press is aimed at. A page that never finishes is acted on after the bound.
  const untilLoaded = async () => {
    try {
      await within(inView(script(loaded, [LOAD_WAIT_MS])), LOAD_WAIT_MS + POLL_MS)
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
    initScript: async (run, ...args) => serial(async () => {
      await cdp('Page.addScriptToEvaluateOnNewDocument', { source: script(run, args) })
    }),
    hover: async (selector, wait = {}) => serial(async () => {
      await untilLoaded()
      await poll(script(scrolledTo, [selector, true]), selector, wait.timeout)

      const [x, y] = await center(selector)

      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    }),
    goto: async path => serial(async () => {
      const target = new URL(path, origin)

      origin = target.origin

      // Navigated again once when the page navigated on its own meanwhile.
      const navigate = async () => {
        try {
          await live(async () => view.navigate(target.href))
        }
        catch (error) {
          if (gone || !NAVIGATED.test(error instanceof Error ? error.message : String(error)))
            throw error

          await live(async () => view.navigate(target.href))
        }
      }

      // A page that does not finish loading, a stalled image holding its load event, is not waited on past the timeout.
      if (await within(navigate(), timeout) === TIMED_OUT)
        throw new Error(`${UNSETTLED} ${timeout}ms waiting for ${target.pathname} to load${heldConnections()}`)

      await settle(ready, `${target.pathname} to load and hydrate its islands`)
    }),
    path: async () => serial(async () => inView<string>('location.pathname + location.search')),
    click: async (selector, { modifiers, ...wait } = {}) => serial(async () => {
      await untilLoaded()

      const budget = wait.timeout ?? timeout
      const until = Date.now() + budget
      // Why the last try could not click, which a budget running out on the next scroll reports rather than the scroll's own wait.
      let refused: Error | undefined

      // Bun's click waits for the element in view without scrolling to it. Centered, so a fixed header or bar does not cover it; at once, so a smooth scroll does not keep it moving. Scrolled again between short waits, as a page restoring its scroll once loaded moves it away. An island not hydrated yet replays the click once it is.
      for (;;) {
        try {
          await poll(script(scrolledTo, [selector, false]), selector, Math.max(until - Date.now(), 1))
        }
        catch (error) {
          throw refused !== undefined && error instanceof Error && error.message.startsWith(UNSETTLED) ? refused : error
        }

        const tried = Date.now()

        try {
          const at = await reach(selector)

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
      await poll(`!!document.querySelector(${JSON.stringify(selector)})`, selector)
      await inView(script((css: string) => {
        const field = document.querySelector<HTMLInputElement>(css)!

        field.focus()
        field.select()
      }, [selector]))

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
    waitFor: async (selector, wait = {}) => serial(async () => {
      const found = script((css: string, text?: string) => [...document.querySelectorAll(css)].some(element => text === undefined || element.textContent?.includes(text)), [selector, wait.text])

      await poll(wait.gone ? `!${found}` : found, `${selector}${wait.text === undefined ? '' : ` with text "${wait.text}"`}${wait.gone ? ' to be gone' : ''}`, wait.timeout)
    }),
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

        // A dev server's own check may be running, and axe-core runs one at a time.
        while (axe._running)
          await new Promise(resolve => setTimeout(resolve, 25))

        // Leaving out a dev server's dev tool.
        const results = await axe.run({ include: context === undefined ? document : [[context]], exclude: [['kay-dev']] }, { resultTypes: ['violations', 'incomplete'] })

        return unreadable(results).map(({ id, impact, help, helpUrl, nodes }) => ({ id, impact, help, helpUrl, nodes: nodes.map(node => ({ target: node.target.map(part => Array.isArray(part) ? part.join(' >>> ') : part).join(' '), html: node.html })) }))
      }, [withUnreadable, selector]))

      if (violations === null)
        throw new Error(`kay: nothing matches ${selector} to check`)

      return violations
    }),
    waitUntil: async (condition, wait = {}, ...args) => serial(async () => poll(script(condition, args), 'the condition to hold', wait.timeout)),
    back: async () => serial(async () => traverse('history.back()')),
    forward: async () => serial(async () => traverse('history.forward()')),
    reload: async () => serial(async () => {
      await live(async () => view.reload())
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

    if (options.javaScript === false)
      await cdp('Emulation.setScriptExecutionDisabled', { value: true })

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
      await within(noteBunProfile(view, dir), timeout)

    page.close()

    throw error
  }

  return page
}

// What a load that stalls says of the pages left open: a browser holds six connections to a host, and a page following a live value keeps one open for as long as the page lives, so the seventh page waits for a connection none will give.
function heldConnections(): string {
  const others = (browser?.pages ?? 1) - 1

  return others < MAX_HOST_CONNECTIONS - 1 ? '' : `; ${others} other pages are still open, and a browser holds only ${MAX_HOST_CONNECTIONS} connections to a host, which a page following a live value keeps open until it is closed: close the pages a test is done with, as \`await using page = await site.open(...)\` does`
}

// A share of the browser for a page, the directory kay owns for it, and whether this page starts the browser.
async function claimBrowser(): Promise<{ dir: string, first: boolean }> {
  if (browser) {
    clearTimeout(browser.idle)
    browser.pages++
    await browser.ready

    return { dir: browser.dir, first: false }
  }

  sweepProfiles()
  browser = { dir: mkdtempSync(join(tmpdir(), `kay-chrome-${process.pid}-`)), pages: 1, ready: killed === undefined ? Promise.resolve() : exited(killed) }
  killed = undefined

  if (!exitHooked)
    process.on('exit', closeBrowser)

  exitHooked = true
  await browser.ready

  return { dir: browser.dir, first: true }
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

  const { dir, idle } = browser
  const pid = LOCK_PID.exec(attempt(() => readlinkSync(join(dir, 'profile', 'SingletonLock'))) ?? '')?.[1]
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
  if (attempt(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8'))?.split('\0').includes(`--user-data-dir=${profile}`) !== true)
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

// The processes running on the profile, read from /proc: Chrome passes its profile to every process it starts.
function naming(profile: string): number[] {
  const flag = `--user-data-dir=${profile}`

  return (attempt(() => readdirSync('/proc')) ?? []).filter(name => attempt(() => readFileSync(`/proc/${name}/cmdline`, 'utf8'))?.split('\0').includes(flag) === true).map(Number)
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
    const argv = attempt(() => readFileSync(`/proc/${name}/cmdline`, 'utf8'))?.split('\0')

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

// axe-core's browser build, read once where the dependency installed.
async function axeSource(): Promise<string> {
  axe ??= await Bun.file(fileURLToPath(import.meta.resolve('axe-core/axe.min.js'))).text()

  return axe
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

// Resolves as `promise` does, or with TIMED_OUT after `ms`: an evaluation a page never answers does not outlast the wait.
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const { promise: timedOut, resolve } = Promise.withResolvers<typeof TIMED_OUT>()
  const timer = setTimeout(resolve, Math.max(ms, 0), TIMED_OUT)

  try {
    return await Promise.race([promise, timedOut])
  }
  finally {
    clearTimeout(timer)
  }
}

// A console argument as text: an object arrives as DevTools describes it, an error with its stack.
function consoleText(arg: unknown): string {
  if (typeof arg !== 'object' || arg === null)
    return String(arg)

  const { description, value } = arg as { description?: string, value?: unknown }

  return description ?? JSON.stringify(value ?? arg)
}
