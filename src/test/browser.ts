import type { AxeResults } from '../runtime/dev-a11y'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'bun:test'
import { withUnreadable } from '../runtime/dev-a11y'
import { ISLAND } from '../runtime/markers'

export interface BrowserOptions {
  // The Chrome or Chromium executable, else `BUN_CHROME_PATH`, else the first one found on the PATH or where it usually installs.
  path?: string | undefined
  width?: number | undefined
  height?: number | undefined
  // How long a page waits for an element, a condition or a navigation, in milliseconds.
  timeout?: number | undefined
  // The page's next call fails once it logs a problem kay recovers from in production, such as an island that did not match its server markup; `false` leaves it in `errors`.
  strict?: boolean | undefined
}

export interface WaitOptions {
  timeout?: number | undefined
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

export interface TestPage {
  // The `Bun.WebView` behind the page, for what the helpers leave out, such as `screenshot()` or `cdp()`.
  view: Bun.WebView
  // The console errors and uncaught exceptions of the page so far.
  errors: string[]
  // Loads a path of the site, or any URL, resolving once the page loaded and its eager islands hydrated.
  goto: (path: string) => Promise<void>
  // The current path and query, a swapped page's included.
  path: () => Promise<string>
  // Scrolls the element to the middle of the view and waits for it to be visible, still and not covered, then clicks it as a user does.
  click: (selector: string, options?: WaitOptions) => Promise<void>
  // Replaces a field's text with `text`, as typing it does, firing `input`.
  fill: (selector: string, text: string) => Promise<void>
  // Types into the focused element.
  type: (text: string) => Promise<void>
  press: (key: Parameters<Bun.WebView['press']>[0], options?: Parameters<Bun.WebView['press']>[1]) => Promise<void>
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
// How long the browser outlives its last page, for the next test's.
const IDLE_MS = 1000
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

// The browser pages are opened in, or undefined when there is none: for `describe.skipIf(!browserPath())`.
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

  // A call of the view, failing at once when the renderer crashed rather than at the test's timeout.
  const live = async <T>(call: Promise<T>): Promise<T> => {
    const answer = await Promise.race([call, crash])

    if (answer === CRASHED)
      throw new Error('kay: the page crashed, its renderer killed or out of memory, so the browser answers nothing more of it')

    return answer
  }
  // A view runs one `inView()` at a time, so the page's calls queue rather than fail when a test runs two at once.
  let queue = Promise.resolve()
  // The view's last `inView()`, which a wait that timed out leaves running: the next waits for it, up to the page's timeout, rather than fail as already pending.
  let evaluating: Promise<unknown> = Promise.resolve()

  const inView = async <T>(expression: string): Promise<T> => {
    const previous = evaluating
    const call = (async () => {
      await within(previous, timeout)

      return live(view.evaluate<T>(expression))
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
        throw new Error(`kay: timed out after ${wait}ms waiting for ${wanted}${failure === undefined ? '' : `, last throwing ${failure instanceof Error ? failure.message : String(failure)}`}`, failure === undefined ? undefined : { cause: failure })

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

  const traverse = async (step: string) => {
    const entry = await inView<string>('navigation.currentEntry.key')

    // `history`, not the view's own back and forward, which wait for a load a swapped page never fires.
    await inView(`void ${step}`)
    await settle(`navigation.currentEntry.key !== ${JSON.stringify(entry)} && ${SETTLED}`, 'the page to settle')
  }

  const page: TestPage = {
    view,
    errors,
    goto: async path => serial(async () => {
      const target = new URL(path, origin)

      origin = target.origin
      await live(view.navigate(target.href))
      await settle(SETTLED, `${target.pathname} to load and hydrate its islands`)
    }),
    path: async () => serial(async () => inView<string>('location.pathname + location.search')),
    click: async (selector, wait = {}) => serial(async () => {
      const budget = wait.timeout ?? timeout
      const until = Date.now() + budget

      // Bun's click waits for the element in view without scrolling to it. Centered, so a fixed header or bar does not cover it; at once, so a smooth scroll does not keep it moving. An island not hydrated yet replays the click once it is.
      await poll(script((target: string) => {
        const element = document.querySelector(target)

        element?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })

        return element !== null
      }, [selector]), selector, budget)
      await live(view.click(selector, { timeout: Math.max(until - Date.now(), 1) }))
    }),
    fill: async (selector, text) => serial(async () => {
      await poll(`!!document.querySelector(${JSON.stringify(selector)})`, selector)
      await inView(script((css: string) => {
        const field = document.querySelector<HTMLInputElement>(css)!

        field.focus()
        field.select()
      }, [selector]))

      await live(text === '' ? view.press('Delete') : view.type(text))
    }),
    type: async text => serial(async () => live(view.type(text))),
    press: async (key, keyOptions) => serial(async () => live(view.press(key, keyOptions))),
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
        const { exceptionDetails } = await live(view.cdp<{ exceptionDetails?: { text: string, exception?: { description?: string } } }>('Runtime.evaluate', { expression: await axeSource() }))

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
      await live(view.reload())
      await settle(SETTLED, 'the page to reload and hydrate its islands')
    }),
    close: () => {
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
    await live(view.navigate('about:blank'))

    if (first)
      await noteBunProfile(view, dir)

    await live(view.cdp('Runtime.enable'))
    await live(view.cdp('Inspector.enable'))
    view.addEventListener('Runtime.exceptionThrown', (event) => {
      const { exceptionDetails } = (event as MessageEvent<{ exceptionDetails: { text: string, exception?: { description?: string } } }>).data

      errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text)
    })
    // Pages share one browser, whose cookies and storage outlive a page. Named one by one, as `all` takes Chrome 2 to 5 s a page, the rest under a millisecond.
    await live(view.cdp('Storage.clearDataForOrigin', { origin, storageTypes: STORAGE_TYPES }))
    await page.goto(url)
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
