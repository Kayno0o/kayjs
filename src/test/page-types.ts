import type { Duration } from '../runtime/duration'
import type { Network, PageResponse } from './network'
import type { WaitUntilOptions } from './wait'

export interface BrowserOptions {
  // The Chrome or Chromium executable, else `BUN_CHROME_PATH`, else a chrome-headless-shell on the PATH or in Playwright's cache, else the first Chrome or Chromium found on the PATH or where it usually installs.
  path?: string | undefined
  width?: number | undefined
  height?: number | undefined
  // How long a page waits for an element, a condition or a navigation, 5 seconds by default, except its loads on a freshly started browser, which waits 20 seconds unless this is given.
  timeout?: Duration | undefined
  // The page's next call fails once it logs a problem kay recovers from in production, such as an island that did not match its server markup; `false` leaves it in `errors`.
  strict?: boolean | undefined
  // A page that does not settle within the timeout, loaded and hydrated, is returned as it stands with the reason in `errors`, instead of failing the call.
  lenient?: boolean | undefined
  // The colour scheme the page is asked for from its first load, `prefers-color-scheme` and `matchMedia` alike.
  colorScheme?: 'light' | 'dark' | undefined
  // The motion preference the page is asked for from its first load, `prefers-reduced-motion` and `matchMedia` alike.
  reducedMotion?: 'reduce' | 'no-preference' | undefined
  // The size the page is laid out at from its first load: `'phone'` (390 by 844, twice the pixel density, as a mobile browser), `'tablet'` (820 by 1180) or your own, `mobile` making the page a mobile one that reads its meta viewport.
  viewport?: 'phone' | 'tablet' | { width: number, height: number, deviceScaleFactor?: number | undefined, mobile?: boolean | undefined } | undefined
  // `false` turns JavaScript off for the page, as a visitor who disabled it: its scripts never run, so a test sees what the server rendered, and `evaluate` and the waits still read the page.
  javaScript?: boolean | undefined
  // Cookies the page's first load carries, for a site's origin, such as a session's: a `Cookie` header string, as `auth.sessionCookie` returns, or a list.
  cookies?: string | { name: string, value: string }[] | undefined
}

export interface WaitOptions {
  timeout?: Duration | undefined
}

// Where in an element a pointer aims: CSS pixels from its top-left corner, for a point of a canvas the element's middle is not.
export interface PointerOptions extends WaitOptions {
  at?: { x: number, y: number } | undefined
}

export interface DragOptions extends WaitOptions {
  // Aims at a point of the source, CSS pixels from its top-left corner, instead of its middle.
  at?: { x: number, y: number } | undefined
  // Aims at a point of the target instead of its middle.
  to?: { x: number, y: number } | undefined
  // How many moves the pointer makes between the two points, 8 by default.
  steps?: number | undefined
  // Milliseconds the pointer rests on the source before it moves, as a touch does to start a drag: a hold drags with touch events, none with the mouse.
  hold?: number | undefined
}

export interface ClickOptions extends PointerOptions {
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
  // The standards and success criteria axe-core files the rule under, such as `wcag2a` and `wcag111`.
  tags: string[]
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
  // `at` aims at a point of the element, scrolled into view, instead of its middle; a click with `at` neither waits for the element to keep still nor checks that nothing covers the point.
  hover: (selector: string, options?: PointerOptions) => Promise<void>
  // Touches the element, scrolled into view, and lifts the finger, as a tap on a touch screen: pointer events whose `pointerType` is `touch`, then the click the browser derives. `at` aims at a point of the element instead of its middle.
  tap: (selector: string, options?: PointerOptions) => Promise<void>
  // Presses the pointer on `from`, scrolled into view, moves it to `to` in `steps` moves and releases it there: a mouse drag, or a touch drag with `hold`, which rests on `from` first. `at` and `to` aim at a point of each element instead of its middle.
  drag: (from: string, to: string, options?: DragOptions) => Promise<void>
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
  waitUntil: <Args extends unknown[]>(condition: (...args: Args) => unknown, options?: WaitUntilOptions, ...args: Args) => Promise<void>
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
  // Moves the page's clock forward by a duration, as `bun test`'s fake timers do: every `setTimeout`, `setInterval`, `after()` and `every()` tick due in that span runs in order, and `Date.now()` and `performance.now()` read the time moved to. It resolves once the last tick ran, before what a tick started, such as a fetch, finished: follow it with `waitFor` or `waitUntil`. The clock otherwise runs in real time, and starts over with each document.
  advance: (duration: Duration) => Promise<void>
  // Runs a function in every document the page loads from now on, before the document's own scripts, in each frame; its arguments cross as for `evaluate`.
  initScript: <Args extends unknown[]>(run: (...args: Args) => unknown, ...args: Args) => Promise<void>
  // Back and forward go through history, swapped pages included, resolving as `goto` does.
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  close: () => void
  [Symbol.asyncDispose]: () => Promise<void>
}
