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

### Override a class a component sets

With Tailwind, `Button(class="px-2")` over the `px-4` a component sets renders `px-2` alone, with no `twMerge` or `cn`. Wherever kay merges classes (the shorthand, `class`, a spread's `class`, a component's `class` prop), a later class drops an earlier one that sets the same CSS properties under the same variants and importance:

- `p-6` after `px-4` drops it, `px-4` after `p-6` keeps both, `hover:p-2` and `p-4` never meet, `!p-2` and `p-4` neither.
- Properties come from the app's own Tailwind, so `@utility`, theme tokens and plugins count: `text-sm` and `text-lg` meet, `text-sm` and `text-red-500` do not.
- A class Tailwind does not know (`.card`), and one built at runtime from parts (`p-${n}`), is never dropped.
- The build writes a table of the classes that can meet another into the manifest, and the islands' entry gets it cut to the classes written in the modules an island bundles or that render one, none when no island has two to merge (a class that reaches an island only as data, such as Markdown or JSON, is merged on the server alone); an app without Tailwind has none and keeps the plain join.
- A lone string is one source, but literal classes written together in one template (`.p-4(class="p-6")`) resolve too, in an island while compiling and on the server while rendering. The `class` of `<html>` from a layout and a page merges the same way.
- Tailwind imported but its design system not loading (a missing import, an uninstalled plugin) logs why in `kay dev` and `kay build`, and merges nothing.

### Style a part of a component

`part="head"` names an element, or a component call, inside a component, with no declaration in `props`. The compiler types the component's `class` from its parts: a string goes to the root, the single top element or the one marked `part="root"`, and an object holds an entry per part, merged onto the part after its own classes like any other class ([Override a class a component sets](#override-a-class-a-component-sets)):

```kay
---
const { title } = props<{ title: string }>()
---
section.rounded.border
  header.p-2(part="head") {title}
  div(part="body")
    slot
```

`Card(title="Hi" class="mt-4")` styles the root, `Card(title="Hi" class={{ root: 'mt-4', head: 'p-6' }})` the root and the head.

- A part renders `data-part="head"`, for selectors and `data-[part=head]:` utilities; one name may sit on several elements, every row of a `for`, and inside an `if` or a slot.
- A part that is a component, `Button(part="action")`, hands its entry to that component's own `class`, a string or an object of its parts: `class={{ action: { icon: 'size-5' } }}`. `data-part` reaches its root through the spread there. Names after the first, `Busy(part="root spinner")`, hand the entries of those parts of this component on as well, under the same names, for a part that sits inside the called component. `kay check` reports a handed part the called component does not name, types its entry as the called component's part takes it, and a page or a layout, which has no class to hand from, refuses one.
- A parts object cannot sit beside a shorthand or a spread on the call, `Card.mt-4(class={{ head: 'p-6' }})`, as it could be a `{ cls: condition }` one: `kay check` reports it, so write the root's classes as `root`. Any `{ name: string }` object there counts as a parts object, a condition value typed `string` included.
- `kay check` reports a part named by an expression, an unknown part at a call, a string `class` for a template with several top elements and no `part="root"`, and a component with parts that also destructures `class`, as the compiler owns that prop. `...rest` leaves `class` out.
- A page or a layout has no `class` prop: its parts render `data-part` only.

### Give a component variants

`recipe({ parts, variants, defaults })` from `kay`, declared as `const card = recipe(...)` in the script, holds the component's classes. `parts` is the base, a string for the root or one string per part, and each variant value is a string for the root or one string per part. The variants become props of the component, typed from the recipe, with nothing declared beside it:

```kay
---
import { recipe } from 'kay'

const card = recipe({
  parts: { root: 'rounded border', head: 'p-4 font-bold', body: 'p-4' },
  variants: {
    tone: { plain: 'bg-white', danger: { root: 'border-red-500', head: 'bg-red-50' } },
    compact: { true: { head: 'p-2', body: 'p-2' } },
  },
  defaults: { tone: 'plain' },
})
const { title } = props<{ title: string }>()
---
section
  header(part="head") {title}
  div(part="body")
    slot
```

`Card(title="Hi" tone="danger" compact)` renders the danger classes on the root and the head, and the compact ones on the head and the body. A variant with only `true` and `false` values is a boolean prop.

- Classes merge in the order the part's own classes, the recipe's base, its variants in the order they are declared, then the caller's `class`, so `Card(compact class={{ head: 'p-6' }})` gives `p-6` ([Override a class a component sets](#override-a-class-a-component-sets)).
- The recipe reaches the same parts `class` does: `part="head"` elements, the root, and a part that is a component, which takes its entry as a string. The variant props never reach `...rest`.
- In an island, a variant changed at runtime swaps its classes. `kay check` reports a value no variant has at the call, `Card(tone="nope")`.
- A component takes one recipe, declared with `const` at the top of its script, which moves to module level: it cannot read the component's props, signals or any name the script declares, and `kay check` reports one that does, a recipe that shares its `const` or sits in a `--- server` fence, and root classes in a template with no `part="root"`. As with parts, it also declares no `class` prop.
- Give a variant its default in the recipe's `defaults`, not in the props destructuring, which the recipe does not read. A numeric value is written as a key, `cols: { 1: 'grid-cols-1' }`, and passed as `cols={1}` or `cols="1"`. A page or a layout takes no recipe.
- `recipe(...)` is a function too: `card({ tone: 'danger' }, 'head')` returns the classes of a part, `root` when none is named.

### Restyle a component from src/ui.ts

`src/ui.ts` sets the parts and variants of any component, the app's own or a library's, with no change to the component. Key each by the specifier `src/ui.ts` would import it with, and write what a recipe takes, without its `defaults`:

```ts
import { defineUi } from 'kay'

export default defineUi({
  '@kaynooo/kayjs-ui/card.kay': {
    parts: { root: 'rounded-xl', head: 'p-6' },
    variants: { tone: { danger: { head: 'bg-red-100' } } },
  },
  './components/panel.kay': { parts: 'shadow-lg' },
})
```

- Classes merge in the order the part's own, the component's recipe base, its variants, `src/ui.ts`'s parts and variants, then the caller's `class`, so `Card(class={{ head: 'p-8' }})` still wins.
- The file is read as it is written at build time and merged into the component's output: the per-page CSS cut sees the final classes, and the parts of an entry without variants are written into the component as static classes, so an island carries nothing for them. It holds string literals and object literals only; a variant reads the component's props and the defaults of its recipe.
- The component must have parts or a recipe, and a variant must be one its recipe declares, so a component with no recipe takes `parts` alone. `kay check` reports an unknown component, part, variant or value, a page, a layout or a server-fenced file, two keys naming one component, a class that is not a plain string and a file with no default export. The dev server rebuilds when `src/ui.ts` changes.

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

In production a page writes its stylesheets into its head as `style` elements while together they compress under about 14 KB, so the first paint waits for no stylesheet request, and above it writes only the rules its own components use, islands included, never the whole stylesheet. A page whose rules are many links a cut copy of the stylesheet instead, without the rules of components it never renders. `inlineStyles` forces one way:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({ inlineStyles: false })
```

## Reference

### Styles

- A component script or any `.ts` module imports its stylesheet: `import './card.css'`. A `--- style` fence holds CSS scoped to the component instead ([Components](components.md#file-layout)); it goes through the same per-page cut.
- Each page links one stylesheet per layout, outermost first, then its own, holding the CSS of every component it renders, islands included, and of those a server fence imports.
- A component or a stylesheet imported in a server fence counts as one the component script imports, though the stylesheets of the `.ts` modules a server fence imports do not.
- Bun bundles them: `@import`, nesting and relative `url()` assets work, and `url(/logo.png)` is left for a public file.
- A component stylesheet may use `@layer components { }`: the layer order the app states, `@layer theme, base, components, utilities;`, still holds though the component sorts before it, as the build moves every top-level `@layer` statement to the start of the stylesheet, in the order written.
- `import theme from './theme.css' with { type: 'text' }` gives the file's text as written (a Tailwind entry's source, not its build) as a string instead, in server code, the compiled executable and an island's script alike, and joins no page stylesheet.
- A name without the attribute is the `css-import-without-text` error.
- By default a page writes those stylesheets into its head as `style` elements when together they gzip under 14,000 bytes, and links them above that, in production and prerendered pages alike, `kay dev` always linking them. The sum is the page's own (its layouts' and its page's), so two pages of one app can differ, and a stylesheet alone over the limit is never inlined.
- Above that limit a page writes into its head the rules of the classes its own components name (the components it renders, islands and the modules they import included, with the `.class` shorthand and Tailwind's utilities alike, star variants such as `*:p-2`, `**:p-2`, `*:*:p-2` and `*:[&.x]:p-2` too), when those fit the limit, and nothing else: no page loads the whole stylesheet after the paint.
- What an island sets after load is counted: the literals of its script and template (ternaries, maps), a parent's literal props at the call site, the classes of the library components it renders, and a name built from a template string or a concatenation, `` `btn-${kind}` ``, which keeps the rules of every class starting or ending with its fixed part. They keep their place in the whole stylesheet's order, so the cascade is the same.
- A class built from a value the build cannot read has no rule on the page: `classList.add(x)`, `className = x`, `setAttribute('class', x)` or a template with an open part no styled class starts or ends with. A production build warns with the island and the line, and the pages reaching its file (`island src/components/chip.kay:12 sets a class from a value the build cannot read`), and the fix is listing the classes in the app's CSS with Tailwind 4.1's `@source inline("...")` (braces and `{1..9}` ranges expand as in Tailwind), whose classes kay keeps on every page and which silences the warning for a name its fixed part matches, or for a bare value once the app lists any. A stylesheet a file reaches keeps every rule it declares, cut by class on no page that reaches it (`.maze td.t { @apply border-t-2 }` stays whatever builds `t`), so a bare value warns no more once a script of the app the file reaches writes out, as a string, a class such a stylesheet declares (`cls.push('t')`), and a class only a stylesheet defines needs no `@source inline`. A member of a `const` object whose values are all literals (`GLASS[tone]`, nested, `as const` or `satisfies` included), also one exported from a relative module (`import { SWATCH_BG } from '../data/site'`, a `Record<K, string>` annotation included), is one of those values, and a call to a function whose every `return` is read this way (literals, ternaries, templates of literals, with `undefined`, `null` and `false` as no class; the function declared in the file or imported) is those values, while one returning a parameter or a call stays open. The classes of a module a value is read from reach the page that imports it, in server code too. A value read back from the element being written (`el.className = el.className`, `getAttribute('class')`) and `cn`, `clsx`, `classNames`, `twMerge` or `cx` of values judged this way do not warn; a name is judged by every `const`, `let` and assignment giving it a value in the file, and a loop's variable, or a parameter of a function, method, arrow or `catch`, is open. The element read back may be any expression written the same on both sides (a call with any arguments, an index, a cast). A static export (`kay build --static`) renders nothing per request, so it gives no warning for a class a server template builds; a route with params is still warned about in a server build, as any value may reach it. A class a server template builds from a value (`class={color}`, `class={`callout ${type}`}`) is judged the same, naming the expression: a prop is its parent's to name, a `const` is read for what it holds, and a page rendered at build time (prerendered, or kept) is read from its HTML, where the classes it shows keep their rules in its head and in the manifest, so it needs no listing and no warning. A bare value (`class={item.color}`, a loop variable or a prop read) gives no warning when every page reaching its file holds, in the script of another module of the app it reaches (the imports of its server code too) or in a JSON file one imports, a string that is a styled class with a hyphen or a variant in it (`color: 'text-blue-200'` in the parent's rows), or renders a collection whose Markdown names one; the rules of those strings are on the page already. A template, a plain word such as `hidden` and the strings of the file setting the class do not count. The warning is printed once the pages are rendered, for the files a page rendered per request reaches.
- `lateStyles: true` in `kay.config.ts` is the way back: a page that inlines its own rules then also links the whole stylesheet after them with `media="print"`, a `data-kay-rest` attribute and a `noscript` copy, which a small inline script (its hash in the policy) makes apply once the head is parsed, so every class has its rule once the stylesheet arrives, the build warns of none and `kay dev` runs no class check. Off by default.
- `kay dev` links the whole stylesheet, so a missing rule never shows there: its pages carry the page's class set instead, and an element getting a class the stylesheet styles but the page lacks logs `[kay] the class "x" is set on <p> ...` once (an error a browser test with `strict` fails on).
- A page rendering a collection's content counts the classes its components, the files that write markup into Markdown (scripts such as a highlighter plugin, Markdown outside code fences and spans, data files) and the `language-` class of a code block name, so it is cut like any other (a class written into Markdown at run time, say through the CMS, or by a plugin from a package, is named by none of them: name it in a project file, or set `inlineStyles` for the whole app); only a class some page or layout names is left out of a page that does not name it: the rules of a class no entry names at all stay on every page, and so do the rules of a stylesheet a page or layout imports itself.
- A page whose own rules pass the limit links a copy of the stylesheet cut to what its files name when that weighs three quarters of the shared one or less (a build writes at most 32, `_layout-<hash>.r-<hash>.css` beside it): the same rules in the same order, so the cascade is the shared stylesheet's, and a page swap loads the next route's copy before it paints. With `offline` on a route links the shared stylesheet, which the worker keeps for every visitor. Pages whose rules fit the limit keep the inline rules, which paint a first view sooner than a linked copy, and a route saving less links the shared stylesheet, which stays cached across routes (a page links the whole sheet only then: the cut would save under a quarter).
- The swap brings the next page's rules with it; `kay dev`, `inlineStyles: true` and `false` do not split.
- `inlineStyles: true` in kay.config.ts inlines every page's whatever their size and `false` links them all, which is how a build before 1.46 behaved.
- The first paint then waits for no stylesheet request, but every page carries the stylesheet again, compressed, since no cache keeps it between pages, the swap's included: past 14 KB that costs more than the request saves, which is why the default links.
- With `compress` on, a rendered page compresses only what lies around them, their compressed copy made once as the server starts, so it goes out as gzip even to a browser taking zstd or brotli: on a 110 KB stylesheet, a fifth of the CPU brotli takes, for no more bytes.
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
- A public file is served `public, max-age=2592000` (30 days) when it is a font (`woff2`, `woff`, `ttf`, `otf`, `eot`), `public, max-age=86400` (a day) when it is an image (`png`, `jpg`, `gif`, `webp`, `avif`, `svg`, `ico`, `bmp`), else `max-age=0, must-revalidate`, always with an ETag: a file replaced in place shows within that time, and `robots.txt`, a manifest, `/sw.js`, scripts and styles always revalidate. `publicCache: { '/fonts/**': '365d', '**/*.png': '30d' }` in `kay.config.ts` sets another time for the files a glob names (`public, max-age=N`, whole seconds rounded up, so `'250ms'` is 1), the first matching glob deciding before those defaults, and `0` keeps the files revalidating (a font changed in place needs it or a new name, since 30 days is long). Globs read the served path, `*` stays inside a folder, `kay dev` ignores both, and `kay build --static` writes the files as they are, their headers being the host's to set (the starter's `nginx.conf` sets the same two times).

A component script, a server fence or a `.ts` module can also import an image, font, video, audio file, PDF or wasm module for its URL, and an island can start a worker: [Imported files and workers](imported-files.md).
