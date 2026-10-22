# Imported files and workers

The images, fonts, media, PDFs and wasm modules a component or module imports for their URL, and the workers an island starts. Public files and stylesheets: [Styles and assets](styles-and-assets.md).

## Common tasks

- Show an imported image, or start a worker from an island: the tasks of [Styles and assets](styles-and-assets.md#common-tasks).

## Reference

### Imported files

A component script, a server fence or a `.ts` module imports an image, font, video, audio file, PDF or wasm module for its URL, typed as a `string`:

```kay
---
import logo from '../logo.png'
---
img(src={logo} alt="Logo")
```

- The URL, such as `/_kay/assets/logo-2k1v9.png`, is named after the file's content and served with a year of immutable caching, so a changed file gets a new URL.
- The server and islands render the same one, and `kay build` writes every file the pages import, through their modules and server fences too.
- A file to serve at a fixed path, such as `robots.txt`, goes in `public/` instead.
- The extension may be upper case, `logo.PNG`; `kay check` types the lower and upper case spellings only.
- These imports are kay's own: a build plugin of the project for the same extensions, such as one inlining SVG, does not apply to them.

### Wasm and workers

- A `.wasm` file is imported for its URL too, then loaded from it: `WebAssembly.instantiateStreaming(fetch(add))`.
- Server code importing one `with { type: 'file' }` keeps Bun's meaning, the file's own path, embedded in an executable.
- An island, and any package it imports, names a file shipped beside a module with `new URL('./file', import.meta.url)`: kay writes the file with the assets, and bundles a script, `.ts`, `.js` or the like, on its own as a worker, its imports included, so `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` starts it in development, a build and a compiled executable alike.
- The URL is relative to the island's chunk, so it holds under a `base`, where an imported file's root-relative URL goes through `withBase` in the browser.
- A package starting itself as its threads' worker, as an emscripten build does, gets a bundle of its own.
- One building its worker in memory from a blob, as qr-scanner does, works as it is.
- Only a relative path written as a string, naming a file, is shipped: a directory, a template with a part, an absolute path or a call inside a comment is left as written.
- A worker bundles as an island does, its stylesheets dropped, its API imports as stubs and `publicEnv` external, but without the config's `plugins`.
- A worker that fails to build fails the build, each error at its `file:line:column`.
- When an island or its worker compiles wasm, kay's `content-security-policy` adds `'wasm-unsafe-eval'` to `script-src`, and `worker-src 'self' blob:` when one starts a worker from a blob.
- They join a `csp` setting its own `script-src` or `worker-src` too, unless it sets that directive to `false` or `'none'`.
- Threads sharing memory need a page isolated from other origins: `security: { headers: { 'cross-origin-embedder-policy': 'credentialless' } }`, kay already sending `cross-origin-opener-policy: same-origin`, in kay.config.ts for the whole site or in a page's `page` for that page alone, which the swap then loads fully.
