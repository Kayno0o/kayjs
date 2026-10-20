# Eco-design (RGESN)

Which criteria of the RGESN 2024, France's general reference for the eco-design of digital services, a web app built on kay meets by itself, which `kay check` and `kay build` verify, and which stay with the app, for an eco-design declaration.

Each row below is one criterion relevant to a web app, marked `Met` (kay does it with no setting from the app, or on a default the app can change), `Checked` (kay reports when the app misses it) or `App` (the app decides, with the setting or API kay gives it). Criteria about the team, the hosting, video, audio, documents or machine learning (1.1 to 1.5, 1.8, 1.10, 2.1, 2.2, 2.4, 2.7, 2.8, 3.1 to 3.6, 4.3, 4.6, 4.7, 4.12 to 4.15, 5.3 to 5.7, 8.x, 9.x) concern no kay feature and are not listed. A declaration still answers them.

## Common tasks

### Fail the build when a page gets heavy

`budget` limits what one page loads of JavaScript and CSS, compressed. `kay build --deny-warnings` fails on the `over-budget` warning, naming the modules weighing most:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  budget: { js: '20kb', css: '10kb', weight: '500kb', grade: 'C' },
})
```

`weight` limits the whole page (HTML, CSS, JS, images and fonts) and `grade` its EcoIndex grade, as the table of pages `kay build` prints measures them: weight, requests, DOM elements, EcoIndex (version 5.10.0 of cnumr's `ecoindex`, from the elements, requests and kilobytes the page has) and grams of CO2e per view. The carbon follows the Sustainable Web Design model v4 as CO2.js 0.19 applies it: 0.3 kWh per gigabyte moved (data center, network and devices, operation and manufacture), 494 gCO2e per kWh, no green hosting assumed, three views in four loading everything and the rest 2% of it. The page is read from the HTML the build wrote, with no browser: images are measured for a 1280 px window, and a request to another site is counted without its weight.

### Load an image at the size it shows

An imported image gets WebP and AVIF variants, and `sizes` says how wide it shows, so a phone loads a small file. The hero image above the fold sets `loading="eager"`, the others load lazily on their own:

```kay
---
import hero from '../hero.jpg'
---
img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" alt="The workshop" loading="eager")
```

### Load a heavy island only when it is seen

`hydrate="visible"` waits until the island scrolls near the viewport, `hydrate="idle"` until the browser is idle:

```kay
---
import Comments from './comments.kay'

const { postId } = props<{ postId: number }>()
---
Comments(postId={postId} hydrate="visible")
```

### Keep a request off every keystroke

`debounced(typed, '300ms')` gives a value once typing has paused, so a search runs once instead of per key; the complete island is in [Components](components.md#react-to-a-change-or-to-typing-once-it-pauses).

## Reference

Links go to where each feature is documented. A row marked `Met` claims only what the linked page says kay does.

### Strategy and specifications

| Criterion | Status | What kay does | Where |
| --- | --- | --- | --- |
| 1.6 Collect data responsibly | Met for what kay keeps, App for the rest | No cookie until a feature needs one, request logs without address, user agent or cookie, sessions that expire, visit counting through the app's own origin and behind consent; the data the app collects is its own | [Privacy](privacy.md#cookies) |
| 1.7 Encryption suited to the needs | App | Cookies are `Secure` over https and the session `__Host-` prefixed; `security.headers` adds HSTS; the TLS itself is the proxy's or host's | [Proxies](proxy-and-security.md#security-headers) |
| 1.9 Standard interoperable technologies | Met | Pages render to plain HTML, a form posts to an action with or without JavaScript, and the rest of a page ships no JavaScript bundle | [Actions](actions.md), [Islands](islands.md#islands) |
| 2.3 Usable over a slow connection or offline | App | `offline: true` turns on a service worker keeping the site's files and chosen pages, with a fallback page | [Offline](sitemap-search-fonts.md#offline) |
| 2.6 Design and code reviews with environmental goals | App | `kay check` and `kay build` report the criteria marked `Checked` below, so a review can lean on them | [Checks](checks.md#what-kay-check-verifies) |
| 2.9 Impact of ready-made UI components | App | `kay build` prints what each island and each route weighs, whole, in requests and in carbon, and `--analyze` names the modules weighing most | [Build](build-and-start.md#build-and-start-commands) |
| 2.10 Impact of third-party services | App | `analytics()` forwards visits from the server so the CSP needs no third-party host; the app chooses which other services it loads | [Privacy](privacy.md#count-visits-through-your-own-origin) |

### Architecture and UX

| Criterion | Status | What kay does | Where |
| --- | --- | --- | --- |
| 3.7 Dev and test environments sized to need | App | Nothing in kay adjusts them; `kay dev` and the tests run on the app's own machine | |
| 4.1 Autoplay off | Checked | `uncontrolled-autoplay` warns of a `video` or `audio` with `autoplay` and no `controls`; a muted autoplay with controls, and an animation, are not looked at | [Lints](lints.md) |
| 4.2 No infinite scroll | App | kay adds none; `paginate(posts, 10)` splits a collection into pages with links | [Content](content.md#pagination) |
| 4.4 The visitor decides on a third-party service | App | `analytics()` waits for the visitor's yes with `consent`, and a persisted signal keeps the answer for any other script, loaded only once it is yes | [Privacy](privacy.md#load-a-script-only-once-the-visitor-agreed) |
| 4.5 Native components | App | A form field is a native `input`, `textarea` or `select`; whether the app swaps them for custom widgets is its own | [Actions](actions.md#forms) |
| 4.8 Few downloaded fonts | App | `fonts` self-hosts font files, each family gets a metric-matched fallback, and a font of several subsets loads only the files the page's text needs; how many families the app declares is its choice | [Fonts](sitemap-search-fonts.md#fonts) |
| 4.9 Few server requests while typing | App | `debounced` gives a value once typing has paused | [Components](components.md#react-to-a-change-or-to-typing-once-it-pauses) |
| 4.10 Input format shown, no useless requests on submit | Met | `field` renders the constraints the schema gives (`required`, lengths) so the browser checks them with no request, and kay's script checks the form against the schema in the browser with the schema's messages | [Forms](actions.md#forms) |
| 4.11 File size and format shown before upload | App | An action refuses a post over `bodyLimit` (1 MB by default) with a message naming the most it may send; showing the limit before the transfer is the app's | [Body limit](action-protection.md#body-limit) |

### Contents

| Criterion | Status | What kay does | Where |
| --- | --- | --- | --- |
| 5.1 Image format suited to its use | Met | An imported PNG, JPEG, WebP, GIF or AVIF gets WebP variants, each also as an AVIF for a browser that takes it, on the same URL; an animated GIF and an SVG keep their format; `images.avif: false` serves WebP alone | [Responsive images](images.md#responsive-images) |
| 5.2 Image compression suited to its context | Met | Variants are made at `images.quality` and `images.avif`'s quality; `image(src, { quality })` sets one image's | [Responsive images](images.md#responsive-images) |
| 5.8 Archive or delete obsolete content | App | `files.delete` removes a file with its variants and cards; the server removes the image variants nothing asked for in 30 days | [Stored files](files.md), [Responsive images](images.md#responsive-images) |

### Frontend

| Criterion | Status | What kay does | Where |
| --- | --- | --- | --- |
| 6.1 A maximum weight and request count per screen | Checked | `budget` warns with `over-budget` for each route over its weight or EcoIndex grade, and `--deny-warnings` or `lints: { 'over-budget': 'deny' }` fails the build; no default limit is set, and `kay build` prints each route's requests, DOM elements, EcoIndex and carbon | [Build](build-and-start.md#build-and-start-commands) |
| 6.2 Caching for what the service transfers | Met | Imported files and built scripts carry a year of immutable caching under a content-named URL; image variants too, and revalidate by ETag when made at runtime; fonts and images in `public/` cache for 30 days and a day, with an ETag | [Imported files](styles-and-assets.md#imported-files), [Public files](styles-and-assets.md#public-files) |
| 6.3 Compression of what is transferred | Met | In production kay compresses pages, actions and routes with zstd, brotli or gzip, and `kay build` writes a brotli and a gzip copy of every text file; `compress: false` turns it off behind a proxy that compresses | [Compression](proxy-and-security.md#compression), [Build](build-and-start.md#build-and-start-commands) |
| 6.4 Images at the size of their display | Met for imported, stored and remote images, Checked for the rest | The `srcset` ladder stops at the image's own width and `sizes` picks the variant; `unsized-image` warns of an `img` with no size and `large-public-image` of a raster over 256 KiB in `public/`, sent whole | [Responsive images](images.md#responsive-images), [Lints](lints.md) |
| 6.5 No loading of unused resources | Met | A component with no handler, `bind:`, `ref` or signal ships no JavaScript; a page writes only the CSS its own components use; every `img` loads lazily; `hydrate="visible"` and `"idle"` defer an island, which is the app's to set | [Islands](islands.md#hydration), [Styles](styles-and-assets.md#link-or-inline-the-stylesheets), [Responsive images](images.md#responsive-images) |
| 6.6 Sensors limited to the need | App | kay reads none | |
| 6.7 Static resources on one domain | Met for what kay serves | Scripts, stylesheets, fonts, image variants and the visit counter come from the site's own origin; an external script or image is the app's | [Fonts](sitemap-search-fonts.md#fonts), [Responsive images](images.md#responsive-images) |

### Backend

| Criterion | Status | What kay does | Where |
| --- | --- | --- | --- |
| 7.1 Server cache for the most used data | App | `cached(key, ttl, load)` keeps what a load fetches, in memory or in a store; `prerender` renders a page once at build time | [Caching](rendering.md#caching), [Prerendering](prerendering.md) |
| 7.2 Retention periods, then deletion or archive | Met for what kay keeps, App for the rest | A session lasts `maxAge` unused and `absoluteMaxAge` at most, a failed job 30 days unless `keepFailed` says less, `sqliteStore` drops expired sessions hourly; the app's own rows and files have the retention it gives them | [Privacy](privacy.md#what-the-server-keeps), [Sessions](server.md#sessions) |
| 7.3 The visitor told of background work | App | An action's `pending()` and `track()` tell an island a post is running; a queued job is invisible until the app shows it | [Calling actions from islands](actions-from-islands.md) |
