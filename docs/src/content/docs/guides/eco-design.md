---
title: Eco-design
order: 9.55
description: Which criteria of the RGESN, France's eco-design reference for digital services, kay meets by itself, which kay check and kay build verify, and which stay with your app.
---

The RGESN 2024 is France's general reference for the eco-design of digital services. An app fills in a declaration against its criteria. This page tells you what kay already does for a web app, so you do not have to work it out.

Each criterion carries one of three marks:

- **Met**: kay does it with nothing from your app, or on a default you can change.
- **Checked**: kay tells you when your app misses it.
- **App**: you decide. kay gives you the setting or the function to do it.

Some criteria are about your team, your host, or video, audio and documents. Others are about machine learning. No kay feature touches them, so they are not listed. Your declaration still answers them.

## Weight and speed

Kay ships little to the browser. A page with no interactive part sends no JavaScript. A page sends only the CSS its own components use. An interactive part is an island, and it can wait until it is seen or until the browser is idle.

| Criterion | Mark | What kay does |
| --- | --- | --- |
| 6.1 A weight limit per screen | Checked | `budget` in `kay.config.ts` warns when a page weighs more than you allow, or has a worse EcoIndex grade. `kay build --deny-warnings` fails the build. No limit is set by default, and `kay build` prints each route's requests. |
| 6.2 Caching | Met | Built files and imported files get a content-named URL and a year of caching. Image variants are cached too. Fonts and images in `public/` are cached for 30 days and a day. |
| 6.3 Compression | Met | In production kay compresses pages and answers with zstd, brotli or gzip. `kay build` also writes a brotli and a gzip copy of every text file. |
| 6.5 No unused resources | Met | A component with nothing interactive ships no JavaScript. Every image loads lazily. Setting `hydrate="visible"` or `"idle"` on an island is up to you. |
| 6.7 One domain for static resources | Met | Scripts, styles, fonts and image variants come from your own origin. A script or image from elsewhere is your choice. |
| 2.9 Impact of ready-made components | App | `kay build` prints what each island and each route weighs, whole, and its carbon per view. `--analyze` names the heaviest modules. |
| 7.1 Server cache | App | `cached(key, ttl, load)` keeps what a load fetches. `prerender` renders a page once, at build time. |

[Performance](/guides/performance) shows the size report and the budget. [Caching and streaming](/guides/caching-and-streaming) covers `cached`. [Deployment](/guides/deployment) covers compression behind a proxy.

## Images and fonts

An imported image gets WebP variants at several widths. Each also comes as AVIF, on the same URL, for browsers that read it. A phone loads a small file, not the original.

| Criterion | Mark | What kay does |
| --- | --- | --- |
| 5.1 Image format | Met | WebP and AVIF variants. An animated GIF and an SVG keep their format. `images.avif: false` serves WebP alone. |
| 5.2 Image compression | Met | Variants use `images.quality`. `image(src, { quality })` sets one image's. |
| 6.4 Image size matches display | Met, and Checked | The `sizes` you write picks the variant. `unsized-image` warns of an image with no size. `large-public-image` warns of a raster over 256 KiB in `public/`, which is sent whole. |
| 4.8 Few fonts | App | `fonts` self-hosts font files. Each family gets a fallback of matching metrics. A font in several subsets loads only the files the page's text needs. How many families you declare is up to you. |
| 5.8 Archive or delete old content | App | `files.delete` removes a file with its variants. The server removes image variants nobody asked for in 30 days. |

A visitor who asks for less data gets a lighter site with no setting. Browsers sending `Save-Data: on` receive the next image width down, no font preloads or speculation rules, and fonts shown only once cached. Pages vary on `Save-Data`, so caches keep both copies. In a browser with `prefers-reduced-data` or a saving connection, links are not prefetched.

Islands wait too: one hydrates once it scrolls near, and the page preloads none of their code, except for islands written `hydrate="load"` or `hydrate="client"`, which still go at once.

`saveData: false` turns all of this off.

[Styling and assets](/essentials/styling-and-assets) covers fonts and imported files. The [file storage guide](/guides/file-storage) covers stored images. [Responsive images](/llms/images#responsive-images) has every rule.

## Forms and interface

| Criterion | Mark | What kay does |
| --- | --- | --- |
| 1.9 Standard technologies | Met | Pages are plain HTML. A form posts to an action with or without JavaScript. |
| 4.1 No autoplay | Checked | `uncontrolled-autoplay` warns of a `video` or `audio` that plays by itself with no `controls`. It does not look at a muted video with controls, or at an animation. |
| 4.2 No infinite scroll | App | kay adds none. `paginate(posts, 10)` splits a collection into pages with links. |
| 4.5 Native components | App | A form field is a native `input`, `textarea` or `select`. Whether you replace them is up to you. |
| 4.9 Few requests while typing | App | `debounced` gives a value once typing has paused. |
| 4.10 Input format shown, no useless request | Met | A field shows the rules its schema gives, and the browser checks them with no request. Kay's script checks the form against the schema too. |
| 4.11 File size shown before upload | App | An action refuses a post over `bodyLimit`, 1 MB by default, and says the most it may send. Showing the limit before the transfer is yours. |
| 2.3 Slow connection or offline | App | `offline: true` turns on a service worker that keeps the site's files and the pages you choose. |

See [Forms and actions](/essentials/forms-and-actions) and [Islands](/essentials/islands).

## Data and third parties

| Criterion | Mark | What kay does |
| --- | --- | --- |
| 1.6 Responsible data collection | Met for what kay keeps | No cookie until a feature needs one. Request logs hold no address, user agent or cookie. Your own data is yours to limit. |
| 7.2 Retention periods | Met for what kay keeps | A session expires after `maxAge` unused. A failed job is dropped after 30 days unless `keepFailed` says less. Your own rows and files keep the retention you give them. |
| 1.7 Encryption | App | Cookies are `Secure` over https. `security.headers` adds HSTS. The TLS itself is your proxy's or host's. |
| 2.10 Third-party services | App | `analytics()` forwards visits from the server, so the CSP needs no third-party host. Other services are your choice. |
| 4.4 The visitor decides on a third-party service | App | `analytics()` can wait for the visitor's yes. A persisted signal keeps the answer for any other script. |
| 7.3 Background work shown | App | An action's `pending()` and `track()` tell an island a post is running. A queued job is invisible until you show it. |

[Privacy](/guides/privacy) lists what kay keeps and for how long, and shows how to count visits and ask for consent.

## Left out

Kay has nothing to say on the sensors criterion (6.6), which kay never reads, or on dev and test environments (3.7). Both stay with your app. Hosting criteria (8.x) are your host's.

<ReadMore href="/llms/eco-design">The same list for an agent, with the setting or lint of each criterion and a link to its rule.</ReadMore>
