# Testing components and helpers

Mounting a component in `bun test` and the helpers for a test of its own, for the tests in [Testing](testing.md).

## Mounting a component

- `mountComponent(Component, props)` from `kay/test` renders one component built for the browser, as an island renders, into `document`, and resolves with `{ root, unmount, setProps }` once its effects ran: for what handlers and effects do, such as a dialog opening on a click.
- `Component` is the one the test imports, whose props are typed; the browser build is made from its file.
- `await setProps({ tiles })` gives the mounted component new values for some of its props, as a parent that re-rendered would (the others keep theirs, a prop it was mounted without can be given), then settles: for a component that follows a prop.
- The mount also has `type(selector, text)`, `click(selector)` and `press(key)`, firing what a browser fires, then settling: `type` focuses an input or textarea and puts the text in it with an `input` event (a `select` takes the option whose value or label is the text, with `input` and `change`), `click` sends the pointer events and the click to the element and focuses it, a disabled one doing nothing, and `press` sends `keydown` and `keyup` to the focused element, Enter committing a text field with its `change` and submitting its form, Enter or Space (`press(' ')`) clicking a button. A text field's `change` also comes when another gesture leaves it. They work on kayjs-ui's TextInput, Select and Segmented.
- On a French site (a `lang` or locale of `fr`) it writes the non-breaking spaces an island does, once `document.documentElement.lang` is `fr`; the other client defines (`KAY_BROWSER`, `KAY_STATIC_EXPORT`) are left out.
- Props may be functions, and the component runs on the test's reactive core, so a signal the test creates reaches it as a prop (`{ read: level }`) and stays live.
- A library's settings apply as `kay.config.ts` sets them.
- A component may `call()` or `resource()` a route of an API module, the project's or an extension's: it is bundled as in the browser, knowing the module only by where it is served, so the call goes out as `fetch` (stub it in the test).
- The modules the component imports from the project and from packages are the test's own, not copies: `import { count } from '../src/store'` in the test and the component's import are one instance, a store of `signal()` or `persisted.cookie()` included, so `count.set(1)` before or after the mount is what the component shows and what it writes is what the test reads. `mock.module('../src/lazy', () => ({ ... }))` or `mock.module('ms', ...)` before the mount reaches the component's static and dynamic imports, and mutating an exported object (`Object.assign(loaders, ...)`) is seen by the component too.
- One instance means the state outlives the mount, across the mounts and tests of a file and the files one worker runs: a test resets what it mutates (`count.set(0)` in `afterEach`). `mock.module()` lasts for the whole process and `mock.restore()` does not undo it: keep the real exports first (`const real = { ...await import('../src/lazy') }`) and mock them back. A persisted signal of such a module reads storage when first read, so `writePersisted` before the first mount, then `set` it; it needs the DOM to exist when the module loads (`kay/test/dom` imported first), and an app module reading `document` or `localStorage` at load is shared too, keeping the first file's happy-dom document: read them lazily.
- A module reaching a `.kay` file (through a barrel too), an API module, a server builtin or an entry kay builds for the browser (`kay/island`), a package choosing its entry by the `browser` condition, and kay's libraries (kayjs-ui, kayjs-cms) stay in the bundle, built for the browser and run afresh by each mount, as does a component's own file: a persisted signal declared there reads storage as it is at each mount, and a library's toasts start empty.
- A test reading `document` before its first mount imports `kay/test/dom` (last, where the preset sorts it), which registers the DOM at once; listed after `kay/test/preload` under `[test] preload`, it registers it for every file.
- It shims the popover API happy-dom lacks: `showPopover`, `hidePopover` and `togglePopover` fire `toggle` as a browser does, and `matches(':popover-open')` reads whether one is shown.
- It leaves `fetch`, `Request`, `Response`, `Headers`, `Blob`, `File`, `URL`, `URLSearchParams`, `AbortController`, `AbortSignal` and `WebSocket` as Bun's, and `FormData` is Bun's class that also reads a form element (a file input keeps its file), so a test serving with `Bun.serve` and fetching it works beside the DOM.
- A test may register the DOM itself instead, such as `GlobalRegistrator.register({ url: 'http://localhost/' })` for a document whose cookies the page reads.
- A DOM left registered for the rest of the run does not reach `testSite`, whose app runs on Bun's own `Request`, `Response` and the rest, so a file mounting components and one visiting pages share one `bun test` run, as long as `kay/test/preload` comes before any preload registering a DOM.
- A function the test stubbed, such as `fetch`, stays its stub there, and a streamed page under a DOM is read through `visit`, `site.fetch` handing back a body read later.
- A `persisted.local(key, initial)` signal keeps its value encoded as island props are, not as JSON: `writePersisted(key, value)` and `readPersisted(key)` from `kay/test` set one before a mount and read one back, `undefined` when none was kept; `'session'` as their last argument does the same for a `persisted.session` signal's sessionStorage.
- After an interaction, `await settle()` lets effects land before the DOM is read.

## Helpers for a test of its own

- `cookieJar()` from `kay/test` keeps a browser's cookies for a test driving an Elysia app or a handler of its own rather than `testSite`, which keeps its own as `site.cookies`.
- `jar.send(handle, request)` sends the cookies kept so far through `handle`, such as `app.handle`, keeps those the response sets and drops those it expires; `jar.header()` is the `cookie` header it sends, `''` when it holds none, and `jar.cookies` the `Bun.CookieMap`.
- `solveWork(challenge)` from `kay/test` solves a proof-of-work challenge, such as one `workChallenge()` signs, as kay's script does, for a test posting a form field by hand, or `undefined` for text that is no challenge.
- `scratchDir(prefix)` from `kay/test` makes a fresh directory under the project's `.kay/scratch` and resolves with its absolute path: inside the project, so a file written there imports the project's packages, and under `.kay`, which no build or check reads, so another test file building beside it never meets it.
- `scratchDir(prefix, root)` puts it under another project's `.kay/scratch`; the test removes the directory once done with it.
- `overrideEnv(env, { MEDIA_DIR: dir })` from `kay/test` gives a `defineEnv` value other variables, `undefined` unsetting an optional one, until `restore()` or the end of a `using`, never `process.env`; only an `env.X` read at call time sees it, not a value copied at import, a value given is not checked against the schema, restores run in reverse order, tests running at once share the one `env`, and `publicEnv` is read apart.

```ts
import { expect } from 'bun:test'
import { cookieJar } from 'kay/test'
import { app } from './app'

const jar = cookieJar()

await jar.send(app.handle, new Request('http://localhost/sign-in', { method: 'POST' }))
expect(jar.cookies.has('kay_session')).toBe(true)
```
