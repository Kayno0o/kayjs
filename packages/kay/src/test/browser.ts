// @kayjs/kay/test browser tests: the built app served on a loopback port of its own, its pages opened in Chromium with islands hydrated.

import type { TestApp, TestAppOptions } from './index'
import { existsSync } from 'node:fs'
import { testApp } from './index'

export interface BrowserTestOptions extends TestAppOptions {
  /** Chrome or Chromium executable; defaults to `BUN_CHROME_PATH`, Playwright's own, then the system's. */
  browserPath?: string | undefined
  /** Milliseconds `open`, `waitFor` and `click` wait before they throw. Default 10000. */
  timeout?: number | undefined
}

export interface BrowserPage {
  readonly url: string
  /** Page errors, `console.error` messages and failed requests (status 400 and up, but the favicon) seen since the page opened. */
  readonly errors: string[]
  /** Runs `fn` (or the expression string) in the page and returns its JSON-serializable result. */
  evaluate<T>(fn: string | (() => T | Promise<T>)): Promise<T>
  /** Waits for a CSS selector to match, or for `fn` to return a truthy value in the page. */
  waitFor(selectorOrFn: string | (() => unknown)): Promise<void>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  /** The text content of the first element matching `selector`. */
  text(selector: string): Promise<string>
  close(): Promise<void>
}

export interface BrowserTest {
  /** The built app, for requests that need no browser. */
  readonly app: TestApp
  /** `http://127.0.0.1:<port>`, a port the test owns. */
  readonly origin: string
  /** Opens `path` and resolves once the page has loaded and the islands that hydrate on load have hydrated. */
  open(path: string): Promise<BrowserPage>
  /** Closes the browser and the server. */
  close(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 10_000

// The few playwright-core types used here, so an app's typecheck never needs playwright-core installed.
interface Page {
  on(event: 'pageerror', listener: (error: Error) => void): void
  on(event: 'response', listener: (response: { status: () => number, url: () => string }) => void): void
  on(event: 'console', listener: (message: { type: () => string, text: () => string }) => void): void
  goto(url: string, options: { waitUntil: 'load', timeout: number }): Promise<unknown>
  evaluate<T>(fn: string | (() => T | Promise<T>)): Promise<T>
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>
  waitForFunction(fn: string | (() => unknown), arg: undefined, options: { timeout: number }): Promise<unknown>
  click(selector: string, options: { timeout: number }): Promise<void>
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>
  locator(selector: string): { first: () => { innerText: (options: { timeout: number }) => Promise<string> } }
}
interface BrowserContext {
  newPage(): Promise<Page>
  close(): Promise<void>
}
interface Browser {
  newContext(): Promise<BrowserContext>
  close(): Promise<void>
}

// True once every island that hydrates on load has hydrated; the ones waiting to be seen, idle or touched are left to the test.
const ISLANDS_HYDRATED = `[...document.querySelectorAll('kay-island')].every(e => ['visible', 'idle', 'interaction'].includes(e.getAttribute('h')) || e._d !== undefined)`

interface PlaywrightCore {
  chromium: { launch: (options: { headless: boolean, executablePath: string }) => Promise<Browser>, executablePath: () => string }
}

async function loadPlaywright(): Promise<PlaywrightCore> {
  try {
    return await import('playwright-core') as unknown as PlaywrightCore
  }
  catch {
    throw new Error('kay: browser tests need playwright-core, and it is not installed: run `bun add -d playwright-core`.')
  }
}

function findBrowser(playwright: PlaywrightCore, given: string | undefined): string {
  if (given !== undefined) {
    if (!existsSync(given))
      throw new Error(`kay: no browser at ${given}: give the path of Chrome or Chromium as \`browserPath\`, or set BUN_CHROME_PATH.`)
    return given
  }
  const found = [process.env.BUN_CHROME_PATH, playwright.chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((path): path is string => typeof path === 'string' && path.length > 0 && existsSync(path))
  if (found === undefined)
    throw new Error('kay: browser tests found no Chrome or Chromium: install one, run `bunx playwright install chromium`, or give its path as `browserPath` or BUN_CHROME_PATH.')
  return found
}

function wrapPage(page: Page, context: BrowserContext, timeout: number, url: string): BrowserPage {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  // A failed load logs a console error without its URL, so the response names it instead; the favicon browsers ask for unprompted is no mistake of the app.
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      errors.push(`${response.status()} ${response.url()}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(message.text())
  })
  return {
    url,
    errors,
    async evaluate(fn) {
      return await page.evaluate(fn as () => never)
    },
    async waitFor(selectorOrFn) {
      if (typeof selectorOrFn === 'string')
        await page.waitForSelector(selectorOrFn, { timeout })
      else
        await page.waitForFunction(selectorOrFn, undefined, { timeout })
    },
    async click(selector) {
      await page.click(selector, { timeout })
    },
    async fill(selector, value) {
      await page.fill(selector, value, { timeout })
    },
    async text(selector) {
      return await page.locator(selector).first().innerText({ timeout })
    },
    async close() {
      await context.close()
    },
  }
}

/** Builds the app for production, serves it on 127.0.0.1 on a free port and opens its pages in Chromium. */
export async function testBrowser(options: BrowserTestOptions): Promise<BrowserTest> {
  const playwright = await loadPlaywright()
  const executablePath = findBrowser(playwright, options.browserPath)
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
  const app = await testApp({ ...options, minify: options.minify ?? true })
  const server = app.app.serve(0, '127.0.0.1')
  const origin = `http://127.0.0.1:${server.port}`
  const stop = async () => {
    server.stop(true)
    await app.app.dispose?.()
  }
  let browser: Browser
  try {
    browser = await playwright.chromium.launch({ headless: true, executablePath })
  }
  catch (error) {
    await stop()
    throw error
  }
  return {
    app,
    origin,
    async open(path) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const url = new URL(path, origin).href
      const wrapped = wrapPage(page, context, timeout, url)
      // Not `networkidle`: a page that polls or streams never goes idle.
      await page.goto(url, { waitUntil: 'load', timeout })
      try {
        await page.waitForFunction(ISLANDS_HYDRATED, undefined, { timeout })
      }
      catch (error) {
        const seen = wrapped.errors.length > 0 ? `; the page reported: ${wrapped.errors.join('; ')}` : ''
        throw new Error(`kay: the islands of ${url} did not hydrate within ${timeout} ms${seen}.`, { cause: error })
      }
      return wrapped
    },
    async close() {
      try {
        await browser.close()
      }
      finally {
        await stop()
      }
    },
  }
}
