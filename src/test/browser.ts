import { existsSync } from 'node:fs'
import process from 'node:process'

export interface BrowserOptions {
  // The Chrome or Chromium executable, else `BUN_CHROME_PATH`, else the first one found on the PATH or where it usually installs.
  path?: string
  width?: number
  height?: number
  // How long a page waits for an element, a condition or a navigation, in milliseconds.
  timeout?: number
}

export interface WaitOptions {
  timeout?: number
}

export interface WaitForOptions extends WaitOptions {
  // Only an element whose text contains this.
  text?: string
  // Waits for no element to match instead.
  gone?: boolean
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
  // Scrolls the element to the middle of the view and waits for it to be visible, still and not covered, and for an island hydrating once visible or idle around it to be live, then clicks it as a user does.
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
  // Waits for a function run in the page, as `evaluate` runs it, to return something truthy.
  waitUntil: <Args extends unknown[]>(condition: (...args: Args) => unknown, options?: WaitOptions, ...args: Args) => Promise<void>
  // Back and forward go through history, swapped pages included, resolving as `goto` does.
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  close: () => void
  [Symbol.asyncDispose]: () => Promise<void>
}

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
const SETTLED = `document.readyState === 'complete' && !document.documentElement.hasAttribute('aria-busy') && [...document.querySelectorAll('slot[data-component]:not([data-hydrate=visible]):not([data-hydrate=idle])')].every(island => island._$k)`

// The browser pages are opened in, or undefined when there is none: for `describe.skipIf(!browserPath())`.
export function browserPath(path?: string): string | undefined {
  const given = path ?? process.env.BUN_CHROME_PATH

  if (given)
    return existsSync(given) ? given : Bun.which(given) ?? undefined

  for (const name of EXECUTABLES) {
    const found = Bun.which(name)

    if (found)
      return found
  }

  return INSTALLED.find(file => existsSync(file))
}

// Opens `url` of a server already running in a headless Chrome, as a visitor with no cookies or storage for the site yet.
export async function browse(url: string, options: BrowserOptions = {}): Promise<TestPage> {
  const executable = browserPath(options.path)

  if (!executable) {
    const given = options.path ?? process.env.BUN_CHROME_PATH

    throw new Error(given ? `kay: no browser at ${given}` : 'kay: browser tests need Chrome or Chromium, and none was found; install one, or give its path as the `path` option or `BUN_CHROME_PATH`')
  }

  const timeout = options.timeout ?? TIMEOUT_MS
  const errors: string[] = []
  // Chrome refuses to run its sandbox as root, as in a CI container, whose small /dev/shm crashes its renderer.
  const argv = process.getuid?.() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
  const view = new Bun.WebView({
    width: options.width,
    height: options.height,
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

      return await run()
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
          if (answer)
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
      const until = Date.now() + (wait.timeout ?? timeout)
      const css = JSON.stringify(selector)

      await poll(`!!document.querySelector(${css})`, selector, until - Date.now())
      // Centered, so a fixed header or bar does not cover it, and at once, so a smooth scroll does not keep it moving.
      await view.evaluate(script((target: string) => document.querySelector(target)!.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), [selector]))
      // A click landing before such an island hydrated would reach no handler.
      await poll(script((target: string) => {
        const island = document.querySelector(target)?.closest('slot[data-hydrate=visible], slot[data-hydrate=idle]')

        return !island || Boolean((island as { _$k?: unknown })._$k)
      }, [selector]), `the island around ${selector} to hydrate`, until - Date.now())
      await view.click(selector, { timeout: Math.max(until - Date.now(), 0) })
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
  await page.goto(url)

  return page
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
