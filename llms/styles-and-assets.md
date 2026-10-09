# Styles and assets

## Styles

A component script or any `.ts` module imports its stylesheet: `import './card.css'`. Each page links one stylesheet per layout, outermost first, then its own, holding the CSS of every component it renders, islands included. Bun bundles them: `@import`, nesting and relative `url()` assets work, and `url(/logo.png)` is left for a public file.

`inlineStyles: true` in kay.config.ts writes those stylesheets into each page's head as `style` elements instead of linking them, in production and prerendered pages, `kay dev` still linking them: the first paint waits for no stylesheet request, which on a phone over slow 4G painted a page with a 110 KB stylesheet 440 ms sooner, but every page then carries the stylesheet again, compressed, since no cache keeps it between pages, the swap's included. With `compress` on, a rendered page compresses only what lies around them, their compressed copy made once as the server starts, so it goes out as gzip even to a browser taking brotli: on a 110 KB stylesheet, a fifth of the CPU brotli takes, for no more bytes. A streamed page, one with an `await` block, compresses whole as before. Their relative `url()`s point where the linked file's did, and kay's `content-security-policy` lets each through by its hash. Pages `kay build` prerendered keep what the setting was then, so it belongs in kay.config.ts rather than in `pages()` alone, where a server turning it off would hash none of their styles.

Tailwind runs as a build plugin. `bun add -d tailwindcss bun-plugin-tailwind`, then:

```ts
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ plugins: [tailwind] })
```

`src/app.css`, imported by the root `_layout.kay`, needs nothing more than `@import 'tailwindcss';`. Tailwind cannot read classes off the `.class` shorthand, `div.md:flex.w-1/2`, so kay collects them into `.kay/classes.txt` and hands them to it as the stylesheets build; `source(none)` on the import turns that off along with Tailwind's own scan of the project.

## Public files

Files in `public/` (the `publicDir` option) are served at their path as they are: `public/robots.txt` at `/robots.txt`, `public/logo@2x.png` at `/logo@2x.png`. A `:`, `*` or `'` in a name is served percent-encoded only, as `%3A`, `%2A` or `%27`. A file sharing its path with a page stops the server at boot, as do two pages serving one path.

## Imported files

A component script, a server fence or a `.ts` module imports an image, font, video, audio file or PDF for its URL, typed as a `string`:

```kay
---
import logo from '../logo.png'
---
img(src={logo} alt="Logo")
```

The URL, such as `/_kay/assets/logo-2k1v9.png`, is named after the file's content and served with a year of immutable caching, so a changed file gets a new URL; the server and islands render the same one, and `kay build` writes every file the pages import, through their modules and server fences too. A file to serve at a fixed path, such as `robots.txt`, goes in `public/` instead. The extension may be upper case, `logo.PNG`; `kay check` types the lower and upper case spellings only. These imports are kay's own: a build plugin of the project for the same extensions, such as one inlining SVG, does not apply to them.

### Responsive images

An imported image an `img` takes as its `src` loads the size it shows at:

```kay
---
import hero from '../hero.jpg'
---
img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" alt="The workshop")
```

- An imported PNG, JPEG or WebP gets a `srcset` of WebP variants at 320, 640, 960, 1280, 1920, 2560 and 3840 pixels wide, those below its own width, plus its own; `src` is the 1280 one, or the widest below it; `width` and `height` are its own, so the page keeps its space while it loads, unless the template writes either. `sizes` is the template's, `100vw` when it writes none, with entries added ahead for screens denser than 2x: a 3x phone loads the variant a 2x one would, which looks the same, as `images.maxDensity` below says. Any other file, an SVG for instance, gets its `src` alone, with its size when kay read one. An `img` that writes its own `srcset` keeps its `src` as it is, and a `src` that is no imported file, such as `/logo.png`, goes as it is.
- `image(src, options)` from `kay/image` gives the same props to spread, for an element that is no `img` or an image kay did not import: `img({...image(post.photo, { width: post.photoWidth, height: post.photoHeight, sizes: '100vw' })} alt="")`.
- `image(hero, { aspect: '1/1' })` cuts the image to that shape, its middle kept, each variant cut on the server so a phone loads none of the pixels cut away, instead of CSS `object-fit: cover`: `width` and `height` are the largest box of that shape inside the image, and the variants stop at its width. The ratio is two whole numbers from 1 to 100, read in lowest terms; it must be one `images.aspects` lists, `['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16']` by default, since each one adds a variant per width the route makes on request. An image that cannot be resized, such as an SVG, keeps its `src` alone.
- `shareImage(hero)` from `kay/image` is the URL of an imported image, or one from `images.dirs` or `images.remote`, cut to the 1200x630 share card social sites show, a JPEG, enlarged when smaller, its transparency dropped: `meta(property="og:image" content={shareImage(hero)})` in the page's `head` block, made absolute against `site` like any `og:image`.
- `shareCard({ title, image })` from `kay/image` is the URL of a 1200x630 JPEG card drawn for the page, for `og:image`: `meta(property="og:image" content={shareCard({ title: post.title, image: post.cover })})` in a `head` block. The title is drawn at the bottom left in a face of `fonts`, at the largest of five sizes that holds it in three lines, cut short with an ellipsis past that, `seo.name` under it; `image`, an imported image or one from `images.dirs` or `images.remote`, covers the card and fades into its background below the text, which is the whole card without one. `images.card` in `kay.config.ts` picks the face, `{ font: { family: 'Inter', weight: 800 } }`, by default the first family listed at its weight nearest 700, the `background` (`#111111`) and the text's `color` (`#ffffff`). The face is read from its `.woff2`, `.woff` or `.ttf` file, TrueType outlines only, which every Fontsource face has; a variable face draws at its default weight, a letter the face lacks draws as its missing-glyph box, and letters are kerned by the face's `GPOS` table but set one by one, with no ligatures or right-to-left text. A page asking for a card fails when `fonts` lists none.
- A card is served by `/_kay/card?title=...&sig=...`, drawn on its first request and kept with the variants. The URL is signed with a key the build keeps beside the client build and never serves, so nobody can have the site draw a title of their own; whitespace runs read as one space and a title is cut at 200 characters before it is signed. Each distinct title is one more card file, so a page titled by what visitors type, such as a search, draws one card per query. `kay build` writes the cards its prerendered pages ask for as files, which a static export links, refusing one on an image from `images.dirs`; one on an image from `images.remote` is drawn from a download.
- Variants are served by `/_kay/image?src=...&w=...`, which answers only those widths, `&crop=16x9` for a cut one and `?src=...&card` for the share card. `kay build` writes every variant of every imported image, and the cut ones and share cards its prerendered pages ask for, served as files with a year of immutable caching; development makes them on request, kept in `.kay/cache/images`.
- Images added at runtime, such as uploads, are resized too from a directory listed by the URL path the app serves it at: `images: { dirs: { '/uploads/': 'data/uploads' } }` in `kay.config.ts`, relative to the root, or to where an executable runs. Give their size, `image(post.photo, { width: post.photoWidth, height: post.photoHeight })`, for the variants; without it the image keeps its `src` alone. Each variant is made once per version of the file and revalidated by its ETag, since an upload can change in place; one over 50 megapixels is refused with 413 from its header alone. kay does not serve the originals: the app does.
- Images on another host, such as a CMS, a CDN or an old WordPress, are resized too from a host `images.remote` lists: `images: { remote: ['https://cms.example.com/uploads/', 'https://*.cdn.example.com'] }`, each entry an `http` or `https` origin, its host starting with `*.` for any subdomain, and maybe a path every URL starts with. Give their size, `image(post.cover.url, { width: post.cover.width, height: post.cover.height })`, for the variants, which the route makes from a copy it downloads into `.kay/cache/images/remote` and keeps for the host's `Cache-Control: max-age`, a minute to a week, an hour without one, then asks again with its ETag or date; a changed image gets new variants under a new ETag. A host that fails leaves the last copy served, and one that never answered is asked again a minute later, the route answering 502 meanwhile. A host not listed is refused with 403, as is a redirect to one, so the route is no open proxy. A path without its final slash covers itself and what is below it, `/uploads/a.jpg` but not `/uploads-private/a.jpg`. On the server, `image()` and `shareImage()` leave an absolute URL no entry covers as it is, as content from a CMS may hold one, warning once per host, and `shareCard()` throws for one. A download is cut off past 25 MB or 10 seconds, and an image over 50 megapixels is refused with 413, as an upload is. Since any URL of a listed host may be asked for, a new query each time, at most 500 originals are kept, the least recently used going first with their variants, and one client starts at most 30 downloads a minute, the route answering 429 past them. The variants are served from the site, so the CSP's `img-src` needs no entry for the host.
- `images.maxDensity` in `kay.config.ts` sets the most pixels per CSS pixel an image loads at, 2 by default, at least 1; `Infinity` leaves the browser's choice. The browser lays the image out from its `width` and `height`, so only the variant it picks changes; a `sizes` holding `auto` is left as written.
- `processImage(file, options)` from `kay/server` resizes and encodes an image a user uploaded for the app to store: `await processImage(file, { width: 200, height: 200, fit: 'cover' })` squares it to a 200px WebP, its middle kept; without `fit` it fits inside the box, never enlarged, one side alone keeping its shape. `format` is `webp`, `jpeg` or `png`, `quality` 80 by default; it gives `{ bytes, width, height, type }`. `imageSize(file)` reads `{ width, height, format }` from the header. Both take a `Blob`, such as a form's `File`, or bytes, and refuse an image over `maxPixels`, 50 million by default, before decoding it.
- `images.quality` sets the WebP quality, 80 by default.
- Each variant also comes as an AVIF, a third to a half smaller than the WebP, on the same URL: the route answers it to a browser whose `Accept` names `image/avif`, about 95% of them, and the WebP to any other, with `Vary: Accept` on both. `images.avif: { quality: 60 }` sets its quality, 50 by default, and `images.avif: false` serves WebP alone. `kay build` writes both formats of every imported image's variants, the AVIF taking 50 ms to a second each, on up to four threads, cached between builds as the WebP is. A runtime or remote image's AVIF is encoded on its first request, on a worker thread the server starts then and stops after 30 seconds with nothing to encode, so a request for another page never waits on it. Development and a static export serve WebP alone, and the share card stays a JPEG. A CDN in front of the site must key its cache on `Accept`, or it could hand an AVIF to a browser that cannot read it.
- An element with a spread is not checked for `alt`, so write it.

### Icons

Any [Iconify](https://icon-sets.iconify.design) set the project depends on as `@iconify-json/<prefix>` is imported one icon at a time, `~icons/<prefix>/<name>`. Imported under a capitalised name, it is drawn as a tag, which takes classes and attributes as an element does:

```kay
---
import Home from '~icons/tabler/home'
---
a(href="/")
  Home.size-5
  | Home
```

The tag is the `svg` spreading the icon, `svg({...Home} class="size-5")`, which is also how an icon held in a value, such as a prop, is drawn.

- The import gives the `viewBox`, the markup inlined as `innerHTML`, `aria-hidden="true"`, and a height of `1em` with the width of the icon's ratio, so it sizes to the text around it and takes its colour from `currentColor`; a class or style sizes it otherwise. An icon that means something on its own, with no text beside it, takes `role="img"` and an `aria-label`.
- Only the icons a page or an island imports are in the build; an alias renders as the icon it points at.
- `kay check` declares every icon of the installed sets in `.kay/types/kay-icons.d.ts`, so a misspelt name is reported as a module it cannot find; a bundle naming one fails with the set and the name. kay reads `@iconify-json/<prefix>` packages, not the all-in-one `@iconify/json`: each icon of an installed set is one declaration there and one virtual module the server registers at boot (Tabler, 6,400 icons, takes about 10 ms).

An icon known only at runtime, such as one a user picks from a search, is built from the set's JSON the app imports, which a compiled server carries too. `iconProps(set, name)` from `kay/icons` gives the same props an import gives, aliases, flips and rotations applied, or `undefined` for a name the set lacks; `iconNames(set)` lists its icons and aliases:

```ts
import tabler from '@iconify-json/tabler/icons.json'
import { iconNames, iconProps } from 'kay/icons'

const found = iconNames(tabler).filter(name => name.includes('home')).slice(0, 20).map(name => ({ name, icon: iconProps(tabler, name)! }))
```

- Both are plain functions, so an island can call them too, though a set imported there ships whole to the browser: search on the server and send the props.
