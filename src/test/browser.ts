import { existsSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
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
// Loaded, no page swap in flight, and every island hydrating on load done: `_$k` is set on an island once hydrated.
const SETTLED = `document.readyState === 'complete' && !document.documentElement.hasAttribute('aria-busy') && [...document.querySelectorAll('${ISLAND}:not([data-hydrate=visible]):not([data-hydrate=idle])')].every(island => island._$k)`

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
  const argv = process.getuid?.() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
  const view = new Bun.WebView({
    ...options.width === undefined ? {} : { width: options.width },
    ...options.height === undefined ? {} : { height: options.height },
    backend: { type: 'chrome', path: executable, argv, url: false },
    console: (type, ...args) => {
      if (type === 'error')
        errors.push(args.map(consoleText).join(' '))
    },
  })
  let origin = new URL(url).origin
  // A view runs one `evaluate()` at a time, so the page's calls queue rather than fail when a test runs two at once.
  let queue = Promise.resolve()

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

    for (;;) {
      try {
        const answer = await within(view.evaluate(expression), until - Date.now())

        if (answer !== TIMED_OUT) {
          const settled = Boolean(answer)

          if (settled)
            return

          failure = undefined
        }
      }
      catch (error) {
        failure = error
      }

      if (Date.now() > until)
        throw new Error(`kay: timed out after ${wait}ms waiting for ${wanted}${failure === undefined ? '' : `, last throwing ${failure instanceof Error ? failure.message : String(failure)}`}`, failure === undefined ? undefined : { cause: failure })

      await Bun.sleep(POLL_MS)
    }
  }

  const traverse = async (step: string) => {
    const entry = await view.evaluate<string>('navigation.currentEntry.key')

    // `history`, not the view's own back and forward, which wait for a load a swapped page never fires.
    await view.evaluate(`void ${step}`)
    await poll(`navigation.currentEntry.key !== ${JSON.stringify(entry)} && ${SETTLED}`, 'the page to settle')
  }

  const page: TestPage = {
    view,
    errors,
    goto: async path => serial(async () => {
      const target = new URL(path, origin)

      origin = target.origin
      await view.navigate(target.href)
      await poll(SETTLED, `${target.pathname} to load and hydrate its islands`)
    }),
    path: async () => serial(async () => view.evaluate<string>('location.pathname + location.search')),
    click: async (selector, wait = {}) => serial(async () => {
      const budget = wait.timeout ?? timeout
      const until = Date.now() + budget

      // Bun's click waits for the element in view without scrolling to it. Centered, so a fixed header or bar does not cover it; at once, so a smooth scroll does not keep it moving. An island not hydrated yet replays the click once it is.
      await poll(script((target: string) => {
        const element = document.querySelector(target)

        element?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })

        return element !== null
      }, [selector]), selector, budget)
      await view.click(selector, { timeout: Math.max(until - Date.now(), 1) })
    }),
    fill: async (selector, text) => serial(async () => {
      await poll(`!!document.querySelector(${JSON.stringify(selector)})`, selector)
      await view.evaluate(script((css: string) => {
        const field = document.querySelector<HTMLInputElement>(css)!

        field.focus()
        field.select()
      }, [selector]))

      if (text === '')
        await view.press('Delete')
      else
        await view.type(text)
    }),
    type: async text => serial(async () => view.type(text)),
    press: async (key, keyOptions) => serial(async () => view.press(key, keyOptions)),
    text: async selector => serial(async () => view.evaluate<string | null>(script((css: string) => document.querySelector(css)?.textContent ?? null, [selector]))),
    value: async selector => serial(async () => view.evaluate<string | null>(script((css: string) => document.querySelector<HTMLInputElement>(css)?.value ?? null, [selector]))),
    count: async selector => serial(async () => view.evaluate<number>(script((css: string) => document.querySelectorAll(css).length, [selector]))),
    evaluate: async (run, ...args) => serial(async () => view.evaluate(script(run, args))),
    waitFor: async (selector, wait = {}) => serial(async () => {
      const found = script((css: string, text?: string) => [...document.querySelectorAll(css)].some(element => text === undefined || element.textContent?.includes(text)), [selector, wait.text])

      await poll(wait.gone ? `!${found}` : found, `${selector}${wait.text === undefined ? '' : ` with text "${wait.text}"`}${wait.gone ? ' to be gone' : ''}`, wait.timeout)
    }),
    a11y: async selector => serial(async () => {
      // Injected again after each navigation, which drops it; through DevTools, which the page's CSP does not hold back.
      if (!await view.evaluate<boolean>('!!window.axe')) {
        const { exceptionDetails } = await view.cdp<{ exceptionDetails?: { text: string, exception?: { description?: string } } }>('Runtime.evaluate', { expression: await axeSource() })

        if (exceptionDetails)
          throw new Error(`kay: axe-core did not load in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
      }

      const violations = await view.evaluate<A11yViolation[] | null>(script(async (context?: string) => {
        const { axe } = window as unknown as { axe: Axe }

        if (context !== undefined && document.querySelector(context) === null)
          return null

        // A dev server's own check may be running, and axe-core runs one at a time.
        while (axe._running)
          await new Promise(resolve => setTimeout(resolve, 25))

        // Leaving out the problem panel and the inspector of a dev server.
        const { violations } = await axe.run({ include: context === undefined ? document : [[context]], exclude: [['kay-problems'], ['[data-kay-inspector]']] }, { resultTypes: ['violations'] })

        return violations.map(({ id, impact, help, helpUrl, nodes }) => ({ id, impact, help, helpUrl, nodes: nodes.map(node => ({ target: node.target.map(part => Array.isArray(part) ? part.join(' >>> ') : part).join(' '), html: node.html })) }))
      }, [selector]))

      if (violations === null)
        throw new Error(`kay: nothing matches ${selector} to check`)

      return violations
    }),
    waitUntil: async (condition, wait = {}, ...args) => serial(async () => poll(script(condition, args), 'the condition to hold', wait.timeout)),
    back: async () => serial(async () => traverse('history.back()')),
    forward: async () => serial(async () => traverse('history.forward()')),
    reload: async () => serial(async () => {
      await view.reload()
      await poll(SETTLED, 'the page to reload and hydrate its islands')
    }),
    close: () => view.close(),
    [Symbol.asyncDispose]: async () => page.close(),
  }

  // A blank page first: the DevTools session the next calls use starts with a navigation.
  await view.navigate('about:blank')
  await view.cdp('Runtime.enable')
  view.addEventListener('Runtime.exceptionThrown', (event) => {
    const { exceptionDetails } = (event as MessageEvent<{ exceptionDetails: { text: string, exception?: { description?: string } } }>).data

    errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text)
  })
  // Pages share one browser, whose cookies and storage outlive a page.
  await view.cdp('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })

  // Once open, a page is the caller's to close; one that failed to load is closed here.
  try {
    await page.goto(url)
  }
  catch (error) {
    page.close()

    throw error
  }

  return page
}

interface Axe {
  _running?: boolean
  run: (context: unknown, options: unknown) => Promise<{ violations: (Omit<A11yViolation, 'nodes'> & { nodes: { target: (string | string[])[], html: string }[] })[] }>
}

let axe: string | undefined

// axe-core's browser build, read once where the dependency installed.
async function axeSource(): Promise<string> {
  axe ??= await Bun.file(fileURLToPath(import.meta.resolve('axe-core/axe.min.js'))).text()

  return axe
}

// A call of `run` in the page, an undefined argument kept as such rather than sent as JSON's null.
function script(run: (...args: never[]) => unknown, args: unknown[]): string {
  return `(${run.toString()})(${args.map(arg => arg === undefined ? 'undefined' : JSON.stringify(arg)).join(', ')})`
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
