# Benchmark: kay, SolidJS, Svelte, Astro, Next.js and Nuxt

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.4, Chromium 151.0.7922.34 headless
- kay 1.82.0, solid-js 1.9.17, svelte 5.57.1, astro 7.3.8, next 16.4.3, nuxt 4.6.2
- run on 2026-10-28, each value the median of 3 runs

Every app renders the same markup from the same data, checked before measuring, table rows included: kay, Solid and Svelte behind the same Elysia server, Astro and Nuxt through their own request handlers called in-process, Next through its Node request handler on a local port. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Nuxt hydrates the whole page too, the products coming from an API route into its payload. Astro hydrates its counter and table as SolidJS islands. Next renders server components and hydrates its client ones, the counter and table, streaming the component payload with the page.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`. Astro's island is the Solid table, Next keeps rows and selection in one reducer with memoised rows, Nuxt keeps a shallow ref of plain rows memoised with `v-memo`.

## Build

A clean production build of each app, run 3 times before anything else is timed, the wall time the median. kay is built as `kay build` runs it, `kay check` included, and with `--no-check`, as `astro build` and the rest check nothing (Next's build type-checks the app as it goes). Size is what the build deploys, server and client output, without the dependencies it runs on, source maps and the precompressed copies kay writes beside its files; gzip is each file compressed alone.

|  | kay | kay --no-check | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| build time | 0.58 s (6.67x) | 0.46 s (5.25x) | 0.14 s (1.62x) | **0.09 s** | 1.19 s (13.67x) | 2.18 s (25.06x) | 2.58 s (29.66x) |
| output (gzip) | 65.9 KB (8.07x) | 65.9 KB (8.07x) | **8.2 KB** | 22.5 KB (2.76x) | 137.8 KB (16.87x) | 328.6 KB (40.24x) | 614.7 KB (75.27x) |
| output (raw) | 211.7 KB (10.19x) | 211.7 KB (10.19x) | **20.8 KB** | 59.4 KB (2.86x) | 481.2 KB (23.16x) | 1041.0 KB (50.10x) | 2294.5 KB (110.44x) |
| output files | 48 | 48 | 1 | 1 | 19 | 105 | 133 |

What is counted:

- kay: `.kay/client/dist` (the browser bundle, a chunk per island) and `.kay/client/pages` (the prerendered pages). Its server is not bundled: Bun runs the app's sources, so it adds nothing here.
- Solid and Svelte: `dist`, the browser bundle `Bun.build` writes. Their server code is compiled in memory as the server starts, so it adds nothing here.
- Astro: `dist`, its server entry and its client assets. Next: `.next` without `cache`, `diagnostics`, `types` and the build traces and file lists; its server needs `next` from `node_modules` to run. Nuxt: `.output`, the Nitro server with the dependencies it traced, and `public`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata. Next is left out: it serves only through its own HTTP server, so its renders would carry a socket round trip the others never pay.

|  | kay | solid | svelte | astro | nuxt |
| --- | --- | --- | --- | --- | --- |
| renders/s | **3983** | 1712 (2.33x) | 3861 (1.03x) | 1898 (2.10x) | 583 (6.83x) |
| mean (ms) | **0.3** | 0.6 (2.33x) | 0.3 (1.03x) | 0.5 (2.10x) | 1.7 (6.83x) |
| p50 (ms) | 0.2 (1.02x) | 0.5 (2.19x) | **0.2** | 0.5 (1.95x) | 1.5 (6.45x) |
| p99 (ms) | **0.4** | 1.6 (4.08x) | 0.7 (1.93x) | 1.2 (3.17x) | 3.8 (9.95x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| JS shipped (gzip) | 9.9 KB (1.22x) | **8.2 KB** | 22.5 KB (2.76x) | 8.6 KB (1.05x) | 133.4 KB (16.33x) | 76.4 KB (9.35x) |
| JS shipped (raw) | 24.6 KB (1.18x) | **20.8 KB** | 59.4 KB (2.86x) | 21.0 KB (1.01x) | 445.6 KB (21.45x) | 197.8 KB (9.52x) |
| JS files | 2 | 1 | 1 | 3 | 6 | 6 |
| HTML (gzip) | **8.4 KB** | 21.6 KB (2.57x) | 15.7 KB (1.86x) | 10.3 KB (1.23x) | 23.6 KB (2.81x) | 23.5 KB (2.79x) |
| HTML (raw) | **85.9 KB** | 171.8 KB (2.00x) | 138.7 KB (1.62x) | 90.4 KB (1.05x) | 333.0 KB (3.88x) | 143.9 KB (1.68x) |
| script (ms) | **0.4** | 10.8 (30.21x) | 14.3 (39.77x) | 1.3 (3.51x) | 18.6 (51.72x) | 5.2 (14.36x) |
| style (ms) | 5.7 (1.08x) | 5.4 (1.04x) | **5.3** | 5.5 (1.04x) | 6.0 (1.13x) | 5.8 (1.11x) |
| layout (ms) | 26.1 (1.01x) | 26.4 (1.02x) | 26.1 (1.01x) | 26.3 (1.02x) | 27.0 (1.04x) | **25.9** |
| JS heap | **959.0 KB** | 3194.7 KB (3.33x) | 3347.6 KB (3.49x) | 1306.8 KB (1.36x) | 4184.0 KB (4.36x) | 3863.6 KB (4.03x) |

## Table page in Chromium

|  | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| JS shipped (gzip) | 12.5 KB (1.53x) | **8.2 KB** | 22.5 KB (2.76x) | 9.6 KB (1.17x) | 134.3 KB (16.45x) | 72.3 KB (8.85x) |
| JS shipped (raw) | 30.2 KB (1.45x) | **20.8 KB** | 59.4 KB (2.86x) | 23.1 KB (1.11x) | 448.1 KB (21.57x) | 186.7 KB (8.99x) |
| JS files | 2 | 1 | 1 | 3 | 6 | 6 |
| HTML (gzip) | 1.0 KB (2.13x) | 0.7 KB (1.57x) | **0.5 KB** | 2.7 KB (5.83x) | 2.0 KB (4.29x) | 0.9 KB (1.94x) |
| HTML (raw) | 1.9 KB (2.16x) | 1.3 KB (1.48x) | **0.9 KB** | 6.4 KB (7.33x) | 6.2 KB (7.06x) | 2.1 KB (2.44x) |
| script (ms) | **1.1** | 2.2 (2.09x) | 4.0 (3.78x) | 1.9 (1.76x) | 12.4 (11.64x) | 4.4 (4.16x) |
| style (ms) | 0.2 (1.45x) | 0.2 (1.02x) | **0.2** | 0.2 (1.10x) | 0.2 (1.35x) | 0.2 (1.04x) |
| layout (ms) | 2.6 (1.17x) | **2.2** | 2.3 (1.04x) | 2.2 (1.00x) | 2.7 (1.20x) | 2.3 (1.04x) |
| JS heap | **1351.9 KB** | 1738.4 KB (1.29x) | 1810.4 KB (1.34x) | 1725.8 KB (1.28x) | 2888.6 KB (2.14x) | 2115.4 KB (1.56x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| create 1,000 rows | 29.6 (1.14x) | 26.9 (1.03x) | **26.1** | 26.4 (1.01x) | 29.9 (1.15x) | 26.4 (1.01x) |
| replace 1,000 rows | 25.5 (1.05x) | **24.3** | 25.9 (1.07x) | 24.5 (1.01x) | 29.9 (1.24x) | 27.4 (1.13x) |
| update every 10th row | 2.8 (1.08x) | 2.7 (1.06x) | 2.6 (1.02x) | **2.6** | 4.1 (1.60x) | 3.5 (1.35x) |
| select row | **0.2** | 0.3 (1.50x) | 1.0 (5.00x) | 0.3 (1.50x) | 1.2 (6.00x) | 0.7 (3.50x) |
| swap rows | 2.4 (1.21x) | 2.1 (1.05x) | 2.1 (1.08x) | **1.9** | 20.4 (10.44x) | 2.5 (1.28x) |
| remove row | 2.0 (1.05x) | 2.0 (1.05x) | 2.2 (1.16x) | **1.9** | 3.2 (1.68x) | 4.4 (2.32x) |
| create 10,000 rows | 262 (1.16x) | **226** | 232 (1.02x) | 234 (1.04x) | 360 (1.59x) | 266 (1.18x) |
| append 1,000 rows | 23.9 (1.04x) | **22.9** | 23.4 (1.02x) | 23.1 (1.01x) | 26.6 (1.16x) | 25.4 (1.11x) |
| clear 1,000 rows | 3.0 (1.18x) | 2.6 (1.04x) | 3.2 (1.28x) | **2.5** | 5.0 (2.00x) | 4.2 (1.66x) |
