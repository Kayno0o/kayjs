# Browser-only code

## Common tasks

### Render a component in the browser only

`--- client` for one that cannot render on the server, such as one wrapping a map library:

```kay
--- client
import { drawMap } from './map'

const { center } = props<{ center: [number, number] }>()

onMount(() => drawMap(center))
---
.map
```

## Reference

### Browser-only components

- Some components cannot render on the server: a package that touches `window` as it loads, such as CodeMirror or hls.js, or code reading `localStorage` while rendering.
- Such a component renders in the browser only: the server sends its island as an empty `<slot>`, props included, and the browser renders it there as soon as the page loads, instead of hydrating it.
- Inside another island it renders nothing on the server and is built in place as its parent hydrates.
- An island importing a package that throws on a browser-only global as it loads renders in the browser only, with nothing to write.
- Each package is imported once, in a Bun process of its own, and the answer is kept per package version in `.kay/cache`.
- The server never loads such a package: an island's server module carries none of its script.
- A component whose script fence is `--- client` always renders in the browser only, and is an island even without state.
- Pages, layouts and special pages render on the server, so they cannot be `--- client`.
- `hydrate="client"` renders one use of an island in the browser only: `Map(center={center} hydrate="client")`.

### Browser globals on the server

- A browser-only global is one lib.dom declares and Bun lacks: `window`, `document`, `localStorage`, `sessionStorage`, `innerWidth` and the like.
- `fetch`, `URL`, `WebSocket`, `crypto` and `navigator` exist on the server too and are never reported.
- `kay check` and the editor report a browser-only global read while the component renders: at the script's top level, in a `memo` or an array callback such as `.map`, in a function of the script the render calls, or in a template value.
- Handlers, refs, `effect`, `onMount`, the target of `listen(window, 'keydown', ...)` and other callbacks run in the browser only and report nothing.
- The editor offers two fixes: wrap the statement in `effect`, offered for a statement that is a plain call or assignment, since a declaration would take its name out of reach, or turn the fence into `--- client`.
- `typeof window` while an island renders is reported too: it is `'undefined'` on the server, so the island would render something else in the browser than the markup it hydrates.
- A global reached through a module of the app or a package is not seen; in development, a server render failing on one names it, the `.kay` line reading it, and the same two fixes.

### Server globals in the browser

- A build refuses a chunk the browser loads that reads `process` or `Bun`: such a chunk throws as it evaluates, so every island in it stays dead and only the console says so.
- The error names the chunk and the modules whose own source reads it, a `.kay` fence included.
- This catches a server-only module reaching the browser through what an island imports, directly or through its page's script fence; the fix is to keep that module out of there and pass what it holds as a prop.
- A read a `typeof` asks about first, as a module written for both sides does, passes: inside the `typeof`, in either branch of an `if` or a `?:` testing it, after an early `return`, or through a flag the module stored that answer in.
- A read in the block of a `try` with a `catch` passes too, as the `catch` takes the error a missing global throws.
- A read through `globalThis` is not seen, nor one in a chunk carrying a `process` polyfill of its own, which binds the name.
- `kay dev` and `kay test` build the same way, so they refuse it too.
- An island reaching a builtin a browser lacks, `bun:sqlite` or `async_hooks` through a database library say, is refused with the imports leading there, one line per island: `src/counter.kay -> src/links.ts -> src/db.ts -> bun:sqlite`, cut at the first package since the fix is never inside one.
- An island bundles all of a module it imports, so a helper beside a database the module opens as it loads brings the database along: move the helper to a module importing none of it.
