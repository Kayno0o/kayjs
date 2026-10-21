# Images and icons

## Common tasks

### Load an image at the size it shows

An imported image an `img` takes as its `src` gets a `srcset` of WebP variants, and `sizes` says how wide it shows:

```kay
---
import hero from '../hero.jpg'
---
img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" alt="The workshop")
```

### Crop an image to a shape

`image(src, { aspect })` from `kay/image` cuts the image to that shape on the server, its middle kept:

```kay
---
import { image } from 'kay/image'
import hero from '../hero.jpg'
---
img({...image(hero, { aspect: '1/1' })} alt="The workshop")
```

### Set the image social sites show

`shareImage` cuts an imported image to the 1200x630 share card, for `og:image` in the page's `head` block:

```kay
---
import { shareImage } from 'kay/image'
import hero from '../hero.jpg'
---
head
  meta(property="og:image" content={shareImage(hero)})
```

### Draw a share card for a page

`shareCard({ title, image })` is the URL of a 1200x630 JPEG drawn for the page, from a face of `fonts`:

```kay
---
import { shareCard } from 'kay/image'

const { post } = props<{ post: { title: string, cover: string } }>()
---
head
  meta(property="og:image" content={shareCard({ title: post.title, image: post.cover })})
```

### Resize images uploaded at runtime

`images.dirs` lists a directory by the URL path the app serves it at, and `image()` gets the size for the variants:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  images: { dirs: { '/uploads/': 'data/uploads' } },
})
```

```kay
---
import { image } from 'kay/image'

const { post } = props<{ post: { photo: string, photoWidth: number, photoHeight: number } }>()
---
img({...image(post.photo, { width: post.photoWidth, height: post.photoHeight })} alt="")
```

### Resize images from another host

`images.remote` lists the hosts, each an `http` or `https` origin:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  images: { remote: ['https://cms.example.com/uploads/', 'https://*.cdn.example.com'] },
})
```

```kay
---
import { image } from 'kay/image'

const { post } = props<{ post: { cover: { url: string, width: number, height: number } } }>()
---
img({...image(post.cover.url, { width: post.cover.width, height: post.cover.height })} alt="")
```

### Draw an icon

Any `@iconify-json/<prefix>` set the project depends on is imported one icon at a time, `~icons/<prefix>/<name>`, under a capitalised name that is drawn as a tag:

```kay
---
import Home from '~icons/tabler/home'
---
a(href="/")
  Home.size-5
  | Home
```

## Reference

### Responsive images

An imported image an `img` takes as its `src` loads the size it shows at:

```kay
---
import hero from '../hero.jpg'
---
img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" alt="The workshop")
```

- An imported PNG, JPEG, WebP, GIF or AVIF gets a `srcset` of WebP variants at 320, 640, 960, 1280, 1920 and 2560 pixels wide, those below its own width, plus its own when the ladder reaches it: nothing is wider than the ladder's last width, so a 6000 px photograph is served at 2560 at most, unless `images.widths` is a list of its own, which also gets the image's own size.
- `src` is the 1280 one, or the widest below it; `width` and `height` are its own, so the page keeps its space while it loads, unless the template writes either.
- `sizes` is the template's, `100vw` when it writes none, with entries added ahead for screens denser than 2x: a 3x phone loads the variant a 2x one would, which looks the same, as `images.maxDensity` below says.
- A `sizes` of one length in pixels, `sizes="95px"` for a logo, gets instead one variant per density up to `images.maxDensity` (3 when `Infinity`), each the narrowest the route makes at or above it, a multiple of 16 under 320 or a width of the list, none past the image's own: `96w` and `192w` here; `rem` and `em` follow the font size, so they get the list.
- Any other file, an SVG for instance, gets its `src` alone, with its size when kay read one, and so does an animated GIF, which a variant would flatten to its first frame.
- A GIF or AVIF from `images.dirs`, `images.resolve` or a host gets variants too; an animated one is answered as it is at every width, and so is a GIF Bun.Image reads the header of but cannot decode (a browser may still draw it), instead of a 415 (its share card still answers 415); an imported one gets no variants.
- An `img` that writes its own `srcset` keeps its `src` as it is, and a `src` that is no imported file, such as `/logo.png`, goes as it is.
- Every `img` a template or a collection entry's Markdown body writes loads lazily and decodes off the main thread, `loading="lazy"` and `decoding="async"`, unless it sets its own: the hero image above the fold sets `loading="eager"` or `fetchpriority="high"`, as a lazy one there would show late.
- An image shows its mean color until it loads, `style="background-color:#c86432"` on the `img`, about 35 bytes and no script: kay reads it once per source image, at build for an imported image and for a relative image in a collection entry's Markdown body (kept in the entry's cache, and in the server bundle an executable embeds), and for an image of `images.dirs` or `images.remote` the first time the route reads that version of the file, so a page rendered before then has none.
- An image with any transparency, even a corner, gets no color (it would show through), nor do an SVG, an animated GIF, an AVIF from `images.dirs` or `images.remote`, a stored file whose key holds none (`files.url(key)`: `files.put` keeps the colour in the key of a still, opaque image, [Stored files](files.md)) or an image `images.resolve` looks up, which may be private.
- The color stays behind the loaded image, hidden by it, so `object-fit: contain` shows it beside the picture; an image an island creates in the browser has none, and the server's is left as it is when the island hydrates.
- `no-placeholder` on an `img` (`img(src={hero} no-placeholder alt="")`, also after a spread, where it drops a `style` the spread brings as well), `image(src, { placeholder: false })` and an `img` with a `style` of its own, which is kept alone, leave the color out; `images: { placeholder: false }` in `kay.config.ts` does for every image, reading none for its color at build, and so does a site `security.csp` or `security.reportOnly` whose `style-src` (or `style-src-attr`) lacks `'unsafe-inline'`, as the browser would drop the attribute: a page's own `security` is not read for this.
- `image(src, options)` from `kay/image` gives the same props to spread, for an element that is no `img` or an image kay did not import: `img({...image(post.photo, { width: post.photoWidth, height: post.photoHeight, sizes: '100vw' })} alt="")`.
- `image(hero, { aspect: '1/1' })` cuts the image to that shape, its middle kept, each variant cut on the server so a phone loads none of the pixels cut away, instead of CSS `object-fit: cover`: `width` and `height` are the largest box of that shape inside the image, and the variants stop at its width.
- The ratio is two whole numbers from 1 to 100, read in lowest terms.
- It must be one `images.aspects` lists, `['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16']` by default, since each one adds a variant per width the route makes on request.
- An image that cannot be resized, such as an SVG, keeps its `src` alone.
- `shareImage(hero)` from `kay/image` is the URL of an imported image, or one from `images.dirs` or `images.remote`, cut to the 1200x630 share card social sites show, a JPEG, enlarged when smaller, its transparency dropped: `meta(property="og:image" content={shareImage(hero)})` in the page's `head` block, made absolute against `site` like any `og:image`.
- `shareCard({ title, image })` from `kay/image` is the URL of a 1200x630 JPEG card drawn for the page, for `og:image`: `meta(property="og:image" content={shareCard({ title: post.title, image: post.cover })})` in a `head` block.
- The title is drawn at the bottom left in a face of `fonts`, at the largest of five sizes that holds it in three lines, cut short with an ellipsis past that, `seo.name` under it, in the page's locale when it takes one text per locale (the card's URL then carries the name, signed with the title).
- `image`, an imported image or one from `images.dirs` or `images.remote`, covers the card and fades into its background below the text, which is the whole card without one.
- `image` may be an imported `.svg`, rasterized to cover the card (cut in the middle when its ratio is not the card's, a `viewBox` alone is enough) before the title is drawn on it: `kay build` writes its cards and keeps its drawing in `.kay` for an executable, which draws no SVG and fails with `executable-incomplete` for a card it holds no drawing of. Text in the SVG draws as nothing and is warned of, as in `images.card.logo`; an SVG from `images.dirs`, `images.remote` or a stored file is refused.
- `images.card` in `kay.config.ts` picks the face, `{ font: { family: 'Inter', weight: 800 } }`, by default the first family listed at its weight nearest 700, the `background` (`#111111`) and the text's `color` (`#ffffff`).
- `images.card.logo` names a square image relative to the root, an SVG or a PNG, JPEG or WebP, drawn 96 pixels wide at the top left of every card: `images: { card: { logo: 'src/logo.svg' } }`. A missing, non-square or undrawable one stops the boot and `kay check` reports it, a changed one renames every card, and `kay build` keeps its drawing, which a server on that build and an executable, which draws no SVG, read instead.
- The face is read from its `.woff2`, `.woff` or `.ttf` file, TrueType outlines only, which every Fontsource face has.
- A variable face draws at its default weight, a letter the face lacks draws as its missing-glyph box, and letters are kerned by the face's `GPOS` table but set one by one, with no ligatures or right-to-left text.
- A page asking for a card fails when `fonts` lists none.
- A card is served by `/_kay/card?title=...&sig=...`, drawn on its first request and kept with the variants.
- The URL is signed with a key the build keeps beside the client build and never serves, so nobody can have the site draw a title of their own; whitespace runs read as one space and a title is cut at 200 characters before it is signed.
- Each distinct title is one more card file, so a page titled by what visitors type, such as a search, draws one card per query.
- `kay build` writes the cards its prerendered pages ask for as files, which a static export links, refusing one on an image from `images.dirs`; one on an image from `images.remote` is drawn from a download.
- Variants are served by `/_kay/image?src=...&w=...`, which answers only those widths, `&crop=16x9` for a cut one and `?src=...&card` for the share card.
- `kay build` writes every variant of every imported image, and the cut ones, share cards and widths under 320 its prerendered pages ask for, served as files with a year of immutable caching; development makes them on request, kept in `.kay/cache/images`.
- An image `files.put` stored is resized with no setting, its size read off its key: `img(src={files.url(key)})` (see [Stored files](files.md)).
- Images added at runtime another way are resized too from a directory listed by the URL path the app serves it at: `images: { dirs: { '/uploads/': 'data/uploads' } }` in `kay.config.ts`, relative to the root, or to where an executable runs.
- Give their size, `image(post.photo, { width: post.photoWidth, height: post.photoHeight })`, for the variants; without it the image keeps its `src` alone. kayjs-cms fills `photoWidth` and `photoHeight` in when the field is `imageField({ width: 'photoWidth', height: 'photoHeight' })` (see [Content CMS](content-cms.md)).
- Each variant is made once per version of the file and revalidated by its ETag, since an upload can change in place; one over 50 megapixels is refused with 413 from its header alone.
- The variants the route draws on request, for runtime, stored and remote images, are kept in `.kay/cache/images`; the server removes those nothing wrote for 30 days as it starts and once a day, and the next request draws one again.
- A variant the server cannot write, its cache directory full or read-only, is the server's error, a 500 its error log reports, rather than the 415 of a file kay cannot resize.
- kay does not serve the originals: the app does.
- Images the app looks up its own way, such as by a database id, behind a session: `images.resolve: (src, ctx) => mediaPath(src)` gives the file of a `src` nothing above names, a path relative to the root, or undefined for a 404, and `images.guard: guard(ctx => { if (!ctx.locals.session.get('userId')) ctx.deny(401) })` runs before it, as a page guard does.
- `ctx` is a guard's: `ctx.url.searchParams.get('src')`, the session and `deny()` or `redirect()`, in `resolve` too.
- Its `ctx.locals` holds what the app's plugins add, such as the session, but not Elysia's `cookie`, `query`, `headers` or `body`, which `ctx.cookies`, `ctx.url` and `ctx.request` give, and what the guard sets on `ctx.headers` or its cookies goes out with the image.
- With `resolve` set, `image('/media/42', { width, height })` resizes any `src` starting with `/`, a file extension or not; these answers are `Cache-Control: private, no-cache`, revalidated by their ETag, a refusal `private, no-store`, and a static export refuses `resolve`, having no route.
- The `src` is what any visitor typed: look it up, or `safePath('media', name)` from `kay/server`, never a plain join, as the path `resolve` returns is read as it is, `../` and symlinks followed; `resolve: src => safePath('media', src.slice('/media/'.length))` gives the real path of a file inside `media`, or undefined for a 404 (see [Files from a folder](server.md#files-from-a-folder)).
- `images.guard` without `resolve` fails the boot.
- Images on another host, such as a CMS, a CDN or an old WordPress, are resized too from a host `images.remote` lists: `images: { remote: ['https://cms.example.com/uploads/', 'https://*.cdn.example.com'] }`, each entry an `http` or `https` origin, its host starting with `*.` for any subdomain of a domain (`*.com`, `*.co.uk` and `*.vercel.app` are refused: a wildcard never covers a public suffix, of which kay knows the common ones, not the whole list), and maybe a path every URL starts with.
- An entry may name `http:`, `localhost` or an IP, as a CMS running beside the app in development does.
- A download goes only to public addresses: each hop, redirects included, resolves its host once and connects to the address it checked, answering 502 when any answer is loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254.169.254`), unique-local (`fd00::/8`), reserved, or such an IPv4 address inside an IPv6 one (`::ffff:127.0.0.1`), whatever the spelling of the IP. An entry naming one address or `localhost` (`http://10.0.0.5:9000`, `http://localhost:9000`) is the app's own host and may be private; a host listed by name never may, so an internal CDN is listed by its address. The host is asked directly (`HTTP_PROXY` is not read) and a compressed answer is refused.
- A download is cut off past 25 MB and given up on after 10 s, answering 413 and 502: `images: { remote: [...], remoteMaxSize: '10mb', remoteTimeout: '30s' }` changes them, a size such as `'10mb'` or bytes, a duration such as `'30s'`.
- Give their size, `image(post.cover.url, { width: post.cover.width, height: post.cover.height })`, for the variants, which the route makes from a copy it downloads into `.kay/cache/images/remote` and keeps for the host's `Cache-Control: max-age`, a minute to a week, an hour without one, then asks again with its ETag or date; a changed image gets new variants under a new ETag.
- A host that fails leaves the last copy served, and one that never answered is asked again a minute later, the route answering 502 meanwhile.
- A host not listed is refused with 403, as is a redirect to one, so the route is no open proxy.
- A path without its final slash covers itself and what is below it, `/uploads/a.jpg` but not `/uploads-private/a.jpg`.
- On the server, `image()` and `shareImage()` leave an absolute URL no entry covers as it is, as content from a CMS may hold one, warning once per host, and `shareCard()` throws for one.
- A download is cut off past 25 MB or 10 seconds, and an image over 50 megapixels is refused with 413, as an upload is.
- Since any URL of a listed host may be asked for, a new query each time, at most 500 originals are kept, up to about 13 GB on disk at 25 MB each plus the variants made of them, the least recently used going first with their variants, and one client starts at most 30 downloads a minute, the route answering 429 past them.
- The variants are served from the site, so the CSP's `img-src` needs no entry for the host.
- `images.widths` in `kay.config.ts` sets the ladder, `[320, 640, 960, 1280, 1920, 2560]` by default, the default stops at its last width (add `3840` for screens that need it), a list of your own also gets each image's own size: whole numbers from 1 to 16384, at most 16, in any order; each is a file per image, so a short ladder builds fewer, and the route makes only those, plus the multiples of 16 below the first for an image drawn at a fixed width. `src` is the widest at or under 1280. A list that is empty, too long or holds anything else fails the boot.
- `image(src, { quality: 90 })` sets the WebP quality of that image's variants over `images.quality`, its AVIF one the same step from `images.avif`'s quality (90 gives WebP 90 and AVIF 60 at the defaults), a multiple of 5 from 5 to 100, so the files one image turns into stay bounded; each quality an image is asked for is a file per width of its own (`?q=90` on the route, which refuses any other).
- `images.maxDensity` in `kay.config.ts` sets the most pixels per CSS pixel an image loads at, 2 by default, at least 1; `Infinity` leaves the browser's choice.
- `kay check` warns (`unsized-image`) of an `img` with neither `width` and `height` nor a spread, such as `image()`'s, that may carry them; an imported raster image given as `src={name}` and a stored file's `src={files.url(key)}` alone are sized and left alone; an SVG, a path, a value from data, a `url()` with more joined to it, an image with its own `srcset` or one with only one of the two sizes still warns.
- `kay check` warns (`large-public-image`) of an `img` with a static `src` naming a raster in `public/` over 256 KiB, as public files are sent whole: import the file from `src/` for the resized variants. It is a site lint, so `lints: { 'large-public-image': 'allow' }` in `kay.config.ts` silences it, and an `img` with its own `srcset` is left alone.
- The browser lays the image out from its `width` and `height`, so only the variant it picks changes; a `sizes` holding `auto` is left as written.
- `processImage(file, options)` from `kay/server` resizes and encodes an image a user uploaded for the app to store: `await processImage(file, { width: 200, height: 200, fit: 'cover' })` squares it to a 200px WebP, its middle kept; without `fit` it fits inside the box, never enlarged, one side alone keeping its shape.
- `format` is `webp`, `jpeg` or `png`, `quality` 80 by default; it gives `{ bytes, width, height, type }`.
- `imageSize(file)` from `kay/server` reads `{ width, height, format }` from the header.
- Both take a `Blob`, such as a form's `File`, or bytes, and refuse an image over `maxPixels`, 50 million by default, before decoding it.
- `images.quality` sets the WebP quality, 80 by default, and the JPEG quality of the share cards `shareCard()` and `shareImage()` draw; a card's quality is part of its URL, so changing it renames the cards.
- Each variant also comes as an AVIF, a third to a half smaller than the WebP, on the same URL: the route answers it to a browser whose `Accept` names `image/avif`, about 95% of them, and the WebP to any other, with `Vary: Accept, Save-Data` on both.
- A request with `Save-Data: on` gets the next width down of the ladder, a third less below it, the first step as it is, with its crop and quality; a share card and an animated GIF are unchanged, and `saveData: false` answers the width asked, with `Vary: Accept` alone.
- `images.webp: { quality: 75 }` sets the WebP quality over `images.quality`, which then keeps the share cards' JPEG alone.
- `images.avif: { quality: 60 }` sets its quality, 50 by default, and `images.avif: false` serves WebP alone.
- `kay build` writes both formats of every imported image's variants, the AVIF taking 25 ms to half a second each, on up to four threads, cached between builds as the WebP is.
- A runtime or remote image's AVIF is encoded on its first request, on a worker thread the server starts then and stops after 30 seconds with nothing to encode, so a request for another page never waits on it. A worker that answers nothing for two minutes while it holds tasks is stopped and fails their requests, so a hung decode cannot hold the four drawing slots for good.
- Development and a static export serve WebP alone, and the share card stays a JPEG.
- A CDN in front of the site must key its cache on `Accept`, or it could hand an AVIF to a browser that cannot read it.
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

The tag is the `svg` spreading the icon, `svg({...Home} class="size-5")`, which is also how an icon held in a value, such as a prop, is drawn ([Draw an icon or a component chosen by a value](templates.md#draw-an-icon-or-a-component-chosen-by-a-value)).

- The import gives the `viewBox`, the markup inlined as `innerHTML` (a `SafeHtml`, so a spread accepts it), `aria-hidden="true"`, and a height of `1em` with the width of the icon's ratio, so it sizes to the text around it and takes its colour from `currentColor`; a class or style sizes it otherwise.
- An icon that means something on its own, with no text beside it, takes `role="img"` and an `aria-label`.
- Only the icons a page or an island imports are in the build, and an island's script holds those it uses: an icon in an export or a module it never reads is dropped from it. An alias renders as the icon it points at.
- `kay check` declares every icon of the installed sets in `.kay/types/kay-icons.d.ts`, so a misspelt name is reported as a module it cannot find; a bundle naming one fails with the set and the name.
- kay reads `@iconify-json/<prefix>` packages, not the all-in-one `@iconify/json`: each icon of an installed set is one declaration there and one virtual module the server registers at boot (Tabler, 6,400 icons, takes about 10 ms).

An icon known only at runtime, such as one a user picks from a search, is built from the set's JSON the app imports, which a compiled server carries too. `iconProps(set, name)` from `kay/icons` gives the same props an import gives, aliases, flips and rotations applied, or `undefined` for a name the set lacks; the name may carry the set's prefix, `tabler:home`, as `iconField` stores it; `iconNames(set)` lists its icons and aliases:

```ts
import tabler from '@iconify-json/tabler/icons.json'
import { iconNames, iconProps } from 'kay/icons'

const found = iconNames(tabler)
  .filter(name => name.includes('home'))
  .slice(0, 20)
  .map(name => ({ name, icon: iconProps(tabler, name)! }))
```

- Both are plain functions, so an island can call them too, though a set imported there ships whole to the browser: search on the server and send the props.
