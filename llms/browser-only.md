# Browser-only code

## Common tasks

### Render a component in the browser only

`--- client` for one that cannot render on the server, such as one wrapping a map library:

```kay
--- client
import { onMount } from 'kay'
import { drawMap } from './map'

const { center } = props<{ center: [number, number] }>()

onMount(() => drawMap(center))
---
.map
```

## Reference

### Browser-only components

- Some components cannot render on the server: a package that touches `window` as it loads, such as CodeMirror or hls.js, or code reading `localStorage` while rendering.
- Such a component renders in the browser only: the server sends its island as a `<slot>` holding only its fallback (empty without one), props included, and the browser clears the slot and renders the island there as soon as the page loads, instead of hydrating it.
- Inside another island it renders nothing on the server and is built in place as its parent hydrates.
- An island importing a package that throws on a browser-only global as it loads renders in the browser only, with nothing to write.
- Each package is imported once, in a Bun process of its own, and the answer is kept per package version in `.kay/cache`.
- The server never loads such a package: an island's server module carries none of its script.
- A component whose script fence is `--- client` always renders in the browser only, and is an island even without state.
- Pages, layouts and special pages render on the server, so they cannot be `--- client`.
- `hydrate="client"` renders one use of an island in the browser only: `Map(center={center} hydrate="client")`.

### Fallback while the browser renders

- A map or an editor that renders late shifts the layout and flashes. A fallback is the markup the server sends in the island's slot, which the browser replaces when the island renders.
- A use writes it as an `@fallback` block: `Map(center={center} hydrate="client")` with an `@fallback` block under it holding the skeleton (`.map-skeleton` say). It reaches only that use, and is not a prop of the component: the `fallback` prop or slot a client-only component declares itself is untouched, but an `@fallback` block under such a use is the island's fallback and is not passed on to it.
- A `--- client` component declares its own for every use with an `@fallback` block at the root of its template, beside the markup it renders. A use's block wins over it.
- A component's own fallback renders on the server without the script, so it is static markup: it reads no prop or `const` of the script (`kay check` names one it reads), and takes the place the island fills. It may use the script's imports, a `Spinner` or an icon.
- The fallback is for the first paint: give it the island's size, so nothing moves when the island replaces it. An island inside another one renders nothing on the server, as before.

### Browser globals on the server

- A browser-only global is one lib.dom declares and Bun lacks: `window`, `document`, `localStorage`, `sessionStorage`, `innerWidth` and the like.
- `fetch`, `URL`, `WebSocket`, `crypto` and `navigator` exist on the server too and are never reported.
- `kay check` and the editor report a browser-only global read while the component renders: at the script's top level, in a `memo` or an array callback such as `.map`, in a function of the script the render calls, or in a template value.
- Handlers, refs, `effect`, `onMount`, the target of `listen(window, 'keydown', ...)` and other callbacks run in the browser only and report nothing.
- The editor offers two fixes: wrap the statement in `effect`, offered for a statement that is a plain call or assignment, since a declaration would take its name out of reach, or turn the fence into `--- client`.
- `typeof window` while an island renders is reported too: it is `'undefined'` on the server, so the island would render something else in the browser than the markup it hydrates.
- A global reached through a module of the app or a package is not seen; in development, a server render failing on one names it, the `.kay` line reading it, and the same two fixes.
- An island reading the clock (`Date.now()`, `new Date()`), `Math.random()`, or a `toLocale*String` or `Intl` format given no locale (no `timeZone` for dates) while it renders is the `hydration-mismatch` lint: the server and the browser compute it apart. It is a lint like any other, so a deliberate read (a copyright year, an id overwritten in `onMount`) is allowed with `// kay-allow hydration-mismatch` on or above its line, `kay-allow-file` or `lints: { 'hydration-mismatch': 'warn' }`. A coarse read such as `new Date().getFullYear()` is reported too, as the year differs between the server's time zone and the visitor's for hours around New Year.

### Server globals in the browser

- A build refuses a chunk the browser loads that reads `process` or `Bun`: such a chunk throws as it evaluates, so every island in it stays dead and only the console says so.
- The error names the chunk and the modules whose own source reads it, a `.kay` fence included.
- This catches a server-only module reaching the browser through what an island imports, directly or through its page's script fence; the fix is to keep that module out of there and pass what it holds as a prop.
- A read a `typeof` asks about first, as a module written for both sides does, passes: inside the `typeof`, in either branch of an `if` or a `?:` testing it, after an early `return`, or through a flag the module stored that answer in.
- A read in the block of a `try` with a `catch` passes too, as the `catch` takes the error a missing global throws.
- A read through `globalThis` is not seen, nor one in a chunk carrying a `process` polyfill of its own, which binds the name.
- `kay dev` and `bun test` build the same way, so they refuse it too.
- `kay check` reports the same refusal before any build, as `server-only-in-island` at each island's import of the module, one per island reaching it, or at the read in the island's own script: an island (a component with a `--- server` fence included), or a module it reaches through relative imports, `.ts` modules with an angle-bracket cast too, that reads `process` or `Bun` as the module loads. A read inside a function is left to the build, as only the build knows whether the island calls it; `process.env.NODE_ENV` and a `typeof` guard pass.
- In the browser kay's `s` builds inert stand-ins, so a module an island imports may build schemas as it loads and keep a schema beside its `Static` type, with no validator in the chunk. Reading a key of a schema at module scope, `Object.keys(SHAPE.properties)` say, throws as the island loads; validation stays on the server: [Schemas](schemas.md#schemas).
- An island reaching a builtin a browser lacks, `bun:sqlite` or `async_hooks` through a database library say, is refused with the imports leading there, one line per island: `src/counter.kay -> src/links.ts -> src/db.ts -> bun:sqlite`, cut at the first package since the fix is never inside one. The message says an island cannot import a server module: keep the constants and types an island needs in a module importing no server code. `mountComponent` in `bun test` reports the same chain.
- `kay check` reports it too, as `browser-builtin-import` at each of the island's imports leading there, with the same chain, once per distinct chain. It bundles the import for the browser as the build does, so a package's `browser` condition and field count, a type-only or unused import passes, and only the builtins the build refuses do: `async_hooks`, `worker_threads` and `bun:*`, not `node:path`, `events` or `node:crypto`. A package marked `sideEffects: false` is followed too, a `.kay` component the island renders is followed through its own imports and reported at the island's import of it, and an import that fails to bundle leaves the other imports' reports intact. One island gets one report per chain. Imports of `kay` and its entries are left out. In a project that never names `process` or `Bun` it follows the islands themselves, not the static components.
- An island bundles all of a module it imports, so a helper beside a database the module opens as it loads brings the database along: move the helper to a module importing none of it.
