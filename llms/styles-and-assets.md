# Styles and assets

## Common tasks

### Style a component

A component script imports its stylesheet, and the page links it:

```kay
---
import './card.css'
---
article.card
  slot
```

### Use Tailwind

`bun add -d tailwindcss bun-plugin-tailwind`, then the plugin goes in `kay.config.ts`:

```ts
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ plugins: [tailwind] })
```

`src/app.css`, imported by the root `_layout.kay`, needs nothing more than `@import 'tailwindcss';`.

### Serve a file at a fixed path

A file in `public/` is served at its path as it is, `public/robots.txt` at `/robots.txt`, and `kay check` accepts links to it:

```kay
a(href="/robots.txt") Robots
```

### Show an imported image

A component imports an image for its URL, named after the file's content and cached for a year:

```kay
---
import logo from '../logo.png'
---
img(src={logo} alt="Logo")
```

### Start a worker from an island

`new URL('./worker.ts', import.meta.url)` names a script kay bundles on its own as a worker:

```kay
---
const result = signal('')

onMount(() => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = event => result.set(String(event.data))
  worker.postMessage('start')
  onCleanup(() => worker.terminate())
})
---
p {result()}
```

### Link or inline the stylesheets

In production a page writes its stylesheets into its head as `style` elements while together they compress under about 14 KB, so the first paint waits for no stylesheet request, and above it writes the rules its own components use and links the full stylesheets for the rest, one cached file serving every page. `inlineStyles` forces one way:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({ inlineStyles: false })
```

## Reference

### Styles

- A component script or any `.ts` module imports its stylesheet: `import './card.css'`.
- Each page links one stylesheet per layout, outermost first, then its own, holding the CSS of every component it renders, islands included, and of those a server fence imports.
- A component or a stylesheet imported in a server fence counts as one the component script imports, though the stylesheets of the `.ts` modules a server fence imports do not.
- Bun bundles them: `@import`, nesting and relative `url()` assets work, and `url(/logo.png)` is left for a public file.
- `import theme from './theme.css' with { type: 'text' }` gives the file's text as written (a Tailwind entry's source, not its build) as a string instead, in server code, the compiled executable and an island's script alike, and joins no page stylesheet.
- A name without the attribute is the `css-import-without-text` error.
- By default a page writes those stylesheets into its head as `style` elements when together they gzip under 14,000 bytes, and links them above that, in production and prerendered pages alike, `kay dev` always linking them. The sum is the page's own (its layouts' and its page's), so two pages of one app can differ, and a stylesheet alone over the limit is never inlined.
- Above that limit a page writes into its head the rules of the classes its own components name (the components it renders, islands and the modules they import included, with the `.class` shorthand and Tailwind's utilities alike), when those fit the limit, and links the full stylesheets ahead of them with `media="print"`, a `data-kay-rest` attribute and a `noscript` copy, which a small inline script makes apply once the head is parsed.
- Nothing is configured and nothing is missing: a class no component of the page names (built at runtime, put together by an island in the browser or coming from data) has its rule in the linked stylesheet, applied when it arrives, so such an element shows unstyled until then (and for good without scripts, unless the `noscript` copy applies it), and a name built from a template string, `` `btn-${kind}` ``, keeps the rules of every class starting or ending with its fixed part.
- A page rendering a collection's content, or whose own rules still pass the limit, links its stylesheets whole as before; only a class some page or layout names is left out of a page that does not name it: the rules of a class no entry names at all (from data or Markdown, say) stay inline on every page, and so do the rules of a stylesheet a page or layout imports itself.
- The swap brings the next page's rules with it, the shared stylesheet staying once linked; `kay dev`, `inlineStyles: true` and `false` do not split.
- `inlineStyles: true` in kay.config.ts inlines every page's whatever their size and `false` links them all, which is how a build before 1.46 behaved.
- The first paint then waits for no stylesheet request, which on a phone over slow 4G painted a page with a 110 KB stylesheet 440 ms sooner, but every page carries the stylesheet again, compressed, since no cache keeps it between pages, the swap's included: past 14 KB that costs more than the request saves, which is why the default links.
- With `compress` on, a rendered page compresses only what lies around them, their compressed copy made once as the server starts, so it goes out as gzip even to a browser taking zstd or brotli: on a 110 KB stylesheet, a fifth of the CPU brotli takes, for no more bytes.
- A streamed page, one with an `await` block, compresses whole as before.
- Their relative `url()`s point where the linked file's did, and kay's `content-security-policy` lets each through by its hash.
- Pages `kay build` prerendered keep what the setting and the stylesheets were then, so it belongs in kay.config.ts rather than in `pages()` alone, where a server turning it off would hash none of their styles.
- Tailwind runs as a build plugin. `bun add -d tailwindcss bun-plugin-tailwind`, then:

```ts
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ plugins: [tailwind] })
```

- `src/app.css`, imported by the root `_layout.kay`, needs nothing more than `@import 'tailwindcss';`.
- Tailwind cannot read classes off the `.class` shorthand, `div.md:flex.w-1/2`, so kay collects them into `.kay/classes.txt` and hands them to it as the stylesheets build.
- `source(none)` on the import turns that off along with Tailwind's own scan of the project.

### Public files

- Files in `public/` (the `publicDir` option) are served at their path as they are: `public/robots.txt` at `/robots.txt`, `public/logo@2x.png` at `/logo@2x.png`.
- Dotfiles and dot-directories but `.well-known/`, `.env` files (`.env.local` too) and editor backups (`.bak`, `.old`, `.orig`, `.swp`, `.tmp`, a trailing `~`) are left out, neither served nor copied by `kay build`; `kay build --static` keeps `.htaccess` and `.nojekyll`, which a static host reads.
- A `:`, `*` or `'` in a name is served percent-encoded only, as `%3A`, `%2A` or `%27`.
- A file sharing its path with a page, under any locale's path too, an endpoint, a redirect, an API route or a feed stops the server at boot, as do two pages serving one path.
- kay's own sitemap, `robots.txt`, favicons, manifest and `/sw.js` give way to it.
- As a static host's `try_files $uri $uri.html $uri/index.html` does, an HTML file is also served without its `.html`, and an `index.html` at its directory: `public/shelf/books.html` at `/shelf/books`, `public/shelf/index.html` at `/shelf`, so a site exported into `public/` keeps its links.
- `x.html` wins over `x/index.html`, and anything else served at that path, a file, a page or a redirect, over both.
- `kay check` accepts links to these paths.
- A public file is served `max-age=0, must-revalidate` with an ETag; `publicCache: { '/fonts/**': '365d', '**/*.png': '30d' }` in `kay.config.ts` keeps the files a glob names for that long (`public, max-age=N`), the first matching glob deciding, still with their ETag once it runs out. Globs read the served path, `*` stays inside a folder, `kay dev` ignores it, and `kay build --static` writes the files as they are, their headers being the host's to set.

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

#### Wasm and workers

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
