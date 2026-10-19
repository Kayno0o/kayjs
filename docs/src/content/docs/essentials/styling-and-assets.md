---
title: Styling and assets
order: 7
description: Component stylesheets, Tailwind, public files, imported and responsive images, fonts and icons.
---

Styles and assets are imported where they are used, and Bun bundles them.

## Component styles

A component script imports its stylesheet. A page links the stylesheets of its layouts, then its own, holding the CSS of every component it renders.

```kay
---
import './card.css'
---
article.card
  slot
```

`@import`, nesting and relative `url()` assets work in the stylesheet.

Imported `with { type: 'text' }`, a stylesheet is its text as a string instead. Use it to inline CSS in a mail or a generated page. It joins no page stylesheet.

```ts
import theme from './theme.css' with { type: 'text' }
```

## Linked or inlined styles

In production, a page with small styles writes them into its head, so the browser paints without a stylesheet request. A page whose styles compress to more than about 14 KB links them instead. One cached file then serves every page.

The size counts a page's styles together with its layouts'. Two pages of one app can differ. `kay dev` always links them.

When a page's styles are over that size, kay still inlines what the page uses. It writes into the head only the rules for the classes its components write, Tailwind's included, if they fit under the same size. A page never loads the whole stylesheet after it paints, so a light page stays light.

The classes your islands set after load count too. kay reads them from the island's script and template, from the props a parent passes, and from the components of a library it renders. A name built in a template string, such as `` `btn-${kind}` ``, keeps the rules of every class that starts or ends with its fixed part.

A page whose own rules are still over the size links a copy of the stylesheet instead. The copy has the same rules in the same order, without the rules of components the page never renders. A page links it only when it is a quarter lighter or more, so a site with similar pages keeps one cached file.

### A class kay cannot see

Some classes come from a value kay cannot read: `classList.add(name)`, `el.className = name`, or a class that arrives from your data. The page has no rule for them, so the element shows unstyled. A production build warns about the ones it spots, with the island, the line and the pages that reach it.

A value picked from an object of class names you write out (`GLASS[tone]`), also one imported from another module of your app, needs no listing. Neither does a call to a function whose every `return` is a class name or a choice between some.

A value read back from the element (`el.className = el.className`), a name that only ever holds classes the file writes out, and `cn(...)`, `clsx(...)` or `twMerge(...)` of such values need no listing.

A value read back from `this.el`, a call result such as `document.querySelector('a')`, an indexed element such as `els[i]`, or any longer chain counts too, as long as both sides write the element the same way, and so does an object inside an array given to `cn(...)`. A name that gets another value somewhere else in the file, or is also imported, is judged by all of them, and a parameter of a function, method or `catch`, or a loop's variable, is not read at all.

A static export has no server to render pages, so it gives no warning for a class a server template builds.

To fix it, list the classes in your CSS with Tailwind's `@source inline`. kay keeps them on every page.

```css
@import "tailwindcss";
@source inline("{hover:,}bg-{red,green}-{100,500}");
```

The warning goes away for a class whose fixed part matches one of them.

A class your server builds from data, such as `class={tone}`, is read too. When the page is rendered at build time, kay reads its HTML and keeps the rules of the classes it shows, so you list nothing. A page rendered for each request cannot be read ahead, so the build warns about it with the expression and the line.

#### Load the whole stylesheet anyway

If you would rather not list classes, set `lateStyles` in `kay.config.ts`.

```ts
export default defineConfig({
  lateStyles: true,
})
```

A page then links the whole stylesheet after its own rules, loaded once the first paint is done, as kay did before. Every class gets its style, and the build warns about none. The cost is the whole stylesheet's bytes on a first visit, so it is off by default. In `kay dev` the whole stylesheet is linked, so nothing looks wrong there. Instead, the browser console logs an error when an element gets a class that the stylesheet styles but its page has no rule for.

A page that shows Markdown counts the classes the Markdown, the scripts that write markup into it and its components name. Text in a code block does not count. A class that Markdown gets at run time, through the CMS or from a plugin in a package, is named by none of those, so write it in a file of your project too. With `offline` on, pages link the shared stylesheet, which the worker keeps.

When you move to another page without a reload, the next page's rules come with it. A route with a copy of its own loads it before the page paints.

Set `inlineStyles` in `kay.config.ts` to force one way.

```ts
export default defineConfig({ inlineStyles: false })
```

`true` inlines every page's styles, whatever their size. `false` links them all.

## Tailwind

Tailwind runs as a build plugin. Install it with `bun add -d tailwindcss bun-plugin-tailwind`, then register it in `kay.config.ts`.

```ts
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ plugins: [tailwind] })
```

Import `src/app.css` from the root `_layout.kay`. It needs only `@import 'tailwindcss';`. Classes written with the `.class` shorthand work too.

## Public files

A file in `public/` is served at its path as it is: `public/robots.txt` is `/robots.txt`. Use it for anything that needs a fixed URL.

An HTML file is also served without its `.html`, as a static host does. `public/shelf/books.html` is at `/shelf/books`, and `public/shelf/index.html` at `/shelf`.

Dotfiles, `.env` files and editor backups are neither served nor exported. `.well-known/` is the one dotfile folder that is served. A static export keeps `.htaccess` and `.nojekyll`, which the host reads.

A public file keeps its name when its content changes, so the browser cannot know when to fetch it again. Kay lets it keep a font for 30 days and an image for a day without asking, so a logo replaced in place shows within a day of the deploy. Everything else, such as `robots.txt`, a manifest or a script, is checked on every visit and answered with a 304 while it is unchanged. `kay dev` always checks, so an edit shows at once.

To choose other times, set `publicCache` in `kay.config.ts`:

```ts
export default {
  publicCache: { '/fonts/**': '365d', '**/*.png': '30d' },
}
```

Each key is a glob on the served path and each value a duration. The first glob a file matches decides, and a file none matches gets the times above. A value of `0` makes the files a glob names revalidate on every visit, which a font or logo replaced under the same name needs, as returning visitors would keep the old font for up to 30 days. A static export copies the files, so there the host sets their headers. The `nginx.conf` of a new static site sets the same two times.

<ReadMore href="/llms/styles-and-assets">The editor backup extensions that are left out, and how a public file and a page with the same URL conflict.</ReadMore>

## Imported images

Import an image for its URL. It is a content-named path served with long-lived caching.

```kay
---
import logo from '../logo.png'
---
img(src={logo} alt="Logo")
```

The same goes for fonts, video, audio, PDF and wasm files.

## Wasm and workers

A `.wasm` file is imported for its URL as well, then loaded from it.

```kay
---
import add from '../add.wasm'

onMount(async () => {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(add))
})
---
p Ready
```

A worker is a file named with `new URL`. kay bundles it on its own, imports included.

```ts
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
```

This works in development, in a build and in a compiled executable. When an island or its worker compiles wasm, kay's content security policy allows it.

Threads sharing memory need extra headers, which the reference lists.

## Responsive images

An imported PNG, JPEG, WebP, GIF or AVIF used as an `img` `src` gets a `srcset` of WebP variants, with AVIF for browsers that take it. It also gets its `width` and `height`. An AVIF worker that stops answering for two minutes is stopped and its images fail, so one stuck image cannot hold up the others.

Write `sizes` to say how large the image shows. The browser then loads the smallest variant that fits.

```kay
---
import hero from '../hero.jpg'
---
img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" alt="The workshop")
```

Every image a template or a collection entry's Markdown writes loads lazily and decodes off the main thread, unless it says otherwise. Give the hero image above the fold `loading="eager"` or `fetchpriority="high"`, so it does not show late.

`image(hero, { aspect: '16/9' })` from `kay/image` cuts the variants to a shape instead of relying on `object-fit`. Spread its result on the element.

```kay
---
import { image } from 'kay/image'
import hero from '../hero.jpg'
---
img({...image(hero, { aspect: '16/9', sizes: '100vw' })} alt="The workshop")
```

### Density and shapes

An image never loads at more than 2 pixels per CSS pixel, so a 3x phone gets what a 2x one does. It looks the same. `images.maxDensity` changes the cap, and `Infinity` leaves the choice to the browser.

`aspect` takes only the shapes `images.aspects` lists, each of which adds a variant per width. The default list is `1/1`, `3/2`, `2/3`, `4/3`, `3/4`, `16/9` and `9/16`.

```ts
export default defineConfig({
  images: { maxDensity: 3, aspects: ['1/1', '16/9', '21/9'] },
})
```

### Widths and quality

An image gets variants at 320, 640, 960, 1280, 1920 and 2560 pixels, those narrower than the image itself. None is wider than 2560, even for a larger photograph, which keeps the files small. A screen that needs more, a 4K display at full size, asks with `images.widths: [320, 960, 1920, 3840]`. `images.widths` sets another list, which also gets the image's own size: whole numbers from 1 to 16384, at most 16, in any order. A shorter list builds fewer files.

`image(photo, { quality: 90 })` encodes that one image's variants at a quality of its own, for a photograph that shows banding at the default. `images.quality`, 80 by default, is the quality of all the others, and of the JPEG share cards too; `images.webp: { quality }` sets the WebP variants alone, as `images.avif` does the AVIF ones. The AVIF variants move the same step from `images.avif`'s quality, so 90 gives WebP at 90 and AVIF at 60 by default.

```ts
export default defineConfig({
  images: { widths: [480, 960, 1440, 1920], quality: 75 },
})
```

### Images added at runtime

An uploaded image is no import, so kay does not know where it sits. List the directory by the URL path your app serves it at.

```ts
export default defineConfig({
  images: { dirs: { '/uploads/': 'data/uploads' } },
})
```

An image `files.put` stored needs no entry. For any other, pass its size to `image()` so kay can make the variants.

```kay
---
import { image } from 'kay/image'

const { post } = props<{ post: { photo: string, photoWidth: number, photoHeight: number } }>()
---
img({...image(post.photo, { width: post.photoWidth, height: post.photoHeight })} alt="")
```

Without the size the image keeps its `src` alone.

### Images from another host

The variants the server draws on request are kept in `.kay/cache/images`. It removes the ones nothing wrote for 30 days, at start and once a day, and draws one again if it is asked for later.

An image on a CMS or a CDN is resized too, once its host is in `images.remote`. Each entry is an origin, and its host can start with `*.` for any subdomain. A download is cut off past 25 MB and given up on after 10 s; `remoteMaxSize` and `remoteTimeout` change them.

```ts
export default defineConfig({
  images: { remote: ['https://cms.example.com/uploads/', 'https://*.cdn.example.com'] },
})
```

kay only downloads from public addresses. It looks the host up itself, connects to the address it checked, and does the same for each redirect, so a listed name cannot lead the server to `localhost`, a cloud metadata address or a private network. A wildcard such as `*.co.uk` or `*.vercel.app` is refused, since anyone can own a subdomain there. A host you run on a private network is listed by its address (`http://10.0.0.5:9000`) or as `localhost`, which says it is yours.

`image(url, { width, height })` then works as above. kay downloads the image once and keeps a copy. A host that is not listed is refused, so the route is no open proxy.

kay asks the host directly, without an `HTTP_PROXY`, and does not accept a compressed answer.

### Private images

An image the app keeps behind a session, such as one looked up by a database id, goes through the same variants. `images.resolve` gives its file and `images.guard` admits the request.

```ts
import { defineConfig } from 'kay/server'
import { guard } from 'kay'
import { mediaPath } from './src/media'

export default defineConfig({
  images: {
    guard: guard((ctx) => {
      if (!ctx.locals.session.get('userId'))
        ctx.deny(401)
    }),
    resolve: async src => src.startsWith('/media/') ? mediaPath(src.slice(7)) : undefined,
  },
})
```

`image('/media/42', { width, height })` then resizes that `src`.

The `src` is whatever a visitor asks for. Look it up, and never join it to a directory.

To serve files from a folder, use `safePath` from `kay/server`. It gives the real path of a file inside the folder, or `undefined`.

```ts
import { safePath } from 'kay/server'

resolve: src => src.startsWith('/media/') ? safePath('media', src.slice('/media/'.length)) : undefined,
```

A name that climbs out with `../`, a symlink that leads out of the folder, an empty name, a name with a null byte, a directory and a missing file all give `undefined`. A leading slash is read as the folder itself.

`safePath` reads the filesystem synchronously, and checks when it is called: a link swapped afterwards is not seen, so open the path it gives at once. It does not stop a hard link to a file outside the folder.

## Fonts

`fonts` in `kay.config.ts` self-hosts font files, declared with `@font-face` in every page's head. List an installed Fontsource package once.

```ts
export default defineConfig({
  fonts: [
    { fontsource: '@fontsource-variable/inter' },
    { family: 'Lora', src: 'src/fonts/lora-italic.woff2', style: 'italic' },
  ],
})
```

Then use the family as usual: `font-family: Inter, system-ui, sans-serif`. With Tailwind, write `@theme { --font-sans: Inter, system-ui, sans-serif; }`.

While a font loads, kay shows the text in a stand-in sized like it. It reads the font's metrics and declares a fallback such as `"Inter Fallback"`, a resized system font: Arial or Roboto (Android's), Times New Roman or Noto Serif (Android's), Courier New.

kay adds the fallback right after the family in your stylesheets' `font-family`, `font` and `--font-*` values. The page then barely moves when the font arrives. A stack in an inline `style` attribute is left as you wrote it.

A face can cover only some characters with `unicodeRange`, passed to the `@font-face` as it is. A Fontsource entry takes `subsets: ['latin', 'latin-ext']` instead. Each face then gets its subset's range, and a page loads only the files its text needs.

```ts
export default defineConfig({
  fonts: [{ fontsource: '@fontsource/inter', subsets: ['latin', 'latin-ext'] }],
})
```

The fallback is Arial or Roboto, Times New Roman or Noto Serif, or Courier New, whichever the device has, resized with `size-adjust` and the `ascent-override`, `descent-override` and `line-gap-override` that fit your font. A family with no Latin letters gets none. On Android a monospace family stays unfitted, as only Courier New is listed. Where kay does not rewrite the stack, such as a `style` element or an inline attribute, list `"Inter Fallback"` yourself.

<Callout type="note">

Faces load once the page uses them. `preload: true` fetches one with the page, on a Fontsource entry too, but can hold back the first paint on a slow phone.

</Callout>

## Icons

Any Iconify set installed as `@iconify-json/<prefix>` is imported one icon at a time, as `~icons/<prefix>/<name>`. Imported under a capitalised name, it is a tag that takes classes.

```kay
---
import Home from '~icons/tabler/home'
---
a(href="/")
  Home.size-5
  | Home
```

The icon sizes to the surrounding text and takes its colour from `currentColor`.

An island's script carries only the icons it draws. An icon the island never reads, such as one in an unused export of a module it imports, is left out of its script.

An icon without text beside it needs `role="img"` and an `aria-label`.

### An icon known at runtime

An icon a user picks from a search has no import. Import the set's JSON instead, and `iconProps(set, name)` from `kay/icons` gives the props to spread on an `svg`. It gives `undefined` for a name the set lacks. `iconNames(set)` lists the names.

```ts
import tabler from '@iconify-json/tabler/icons.json'
import { iconNames, iconProps } from 'kay/icons'

const found = iconNames(tabler)
  .filter(name => name.includes('home'))
  .slice(0, 20)
  .map(name => ({ name, icon: iconProps(tabler, name)! }))
```

```kay
---
const { icon } = props<{ icon: Record<string, unknown> }>()
---
svg({...icon})
```

Search on the server and send the props to an island. A set imported in an island ships whole to the browser.

<ReadMore href="/llms/images">Fixed-width images, the limits on remote images, share cards, AVIF settings and `processImage`.</ReadMore>
