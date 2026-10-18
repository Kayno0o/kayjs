# Benchmark: kay, SolidJS, Svelte, Astro, Next.js and Nuxt

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.3, Chromium 151.0.7922.34 headless
- kay 1.54.2, solid-js 1.9.15, svelte 5.57.1, astro 7.3.8, next 16.4.0, nuxt 4.6.1
- run on 2026-10-18, each value the median of 3 runs

Every app renders the same markup from the same data, checked before measuring, table rows included: kay, Solid and Svelte behind the same Elysia server, Astro and Nuxt through their own request handlers called in-process, Next through its Node request handler on a local port. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Nuxt hydrates the whole page too, the products coming from an API route into its payload. Astro hydrates its counter and table as SolidJS islands. Next renders server components and hydrates its client ones, the counter and table, streaming the component payload with the page.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`. Astro's island is the Solid table, Next keeps rows and selection in one reducer with memoised rows, Nuxt keeps a shallow ref of plain rows memoised with `v-memo`.

## Build

A clean production build of each app, run 3 times before anything else is timed, the wall time the median. kay is built as `kay build` runs it, `kay check` included, and with `--no-check`, as `astro build` and the rest check nothing (Next's build type-checks the app as it goes). Size is what the build deploys, server and client output, without the dependencies it runs on, source maps and the precompressed copies kay writes beside its files; gzip is each file compressed alone.

|  | kay | kay --no-check | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| build time | 0.86 s (9.71x) | 0.37 s (4.21x) | 0.14 s (1.62x) | **0.09 s** | 0.63 s (7.04x) | 2.14 s (24.09x) | 1.99 s (22.45x) |
| output (gzip) | 38.0 KB (4.66x) | 38.0 KB (4.66x) | **8.2 KB** | 22.5 KB (2.76x) | 138.1 KB (16.93x) | 328.9 KB (40.33x) | 610.7 KB (74.88x) |
| output (raw) | 153.0 KB (7.37x) | 153.0 KB (7.37x) | **20.8 KB** | 59.4 KB (2.86x) | 485.2 KB (23.38x) | 1041.5 KB (50.19x) | 2277.8 KB (109.77x) |
| output files | 19 | 19 | 1 | 1 | 18 | 105 | 133 |

What is counted:

- kay: `.kay/client/dist` (the browser bundle, a chunk per island) and `.kay/client/pages` (the prerendered pages). Its server is not bundled: Bun runs the app's sources, so it adds nothing here.
- Solid and Svelte: `dist`, the browser bundle `Bun.build` writes. Their server code is compiled in memory as the server starts, so it adds nothing here.
- Astro: `dist`, its server entry and its client assets. Next: `.next` without `cache`, `diagnostics`, `types` and the build traces and file lists; its server needs `next` from `node_modules` to run. Nuxt: `.output`, the Nitro server with the dependencies it traced, and `public`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata. Next is left out: it serves only through its own HTTP server, so its renders would carry a socket round trip the others never pay.

|  | kay | solid | svelte | astro | nuxt |
| --- | --- | --- | --- | --- | --- |
| renders/s | **4166** | 1697 (2.45x) | 3796 (1.10x) | 1827 (2.28x) | 585 (7.12x) |
| mean (ms) | **0.2** | 0.6 (2.45x) | 0.3 (1.10x) | 0.5 (2.28x) | 1.7 (7.12x) |
| p50 (ms) | **0.2** | 0.5 (2.27x) | 0.2 (1.04x) | 0.5 (2.08x) | 1.5 (6.64x) |
| p99 (ms) | **0.4** | 1.6 (4.11x) | 0.8 (1.93x) | 1.3 (3.16x) | 3.9 (9.64x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| JS shipped (gzip) | 12.0 KB (1.47x) | **8.2 KB** | 22.5 KB (2.76x) | 8.6 KB (1.05x) | 133.3 KB (16.34x) | 75.9 KB (9.31x) |
| JS shipped (raw) | 29.3 KB (1.41x) | **20.8 KB** | 59.4 KB (2.86x) | 21.0 KB (1.01x) | 445.4 KB (21.46x) | 196.4 KB (9.47x) |
| JS files | 3 | 1 | 1 | 3 | 6 | 6 |
| HTML (gzip) | **8.4 KB** | 21.6 KB (2.57x) | 15.7 KB (1.86x) | 10.3 KB (1.23x) | 23.6 KB (2.80x) | 23.5 KB (2.79x) |
| HTML (raw) | **85.9 KB** | 171.8 KB (2.00x) | 138.7 KB (1.61x) | 90.4 KB (1.05x) | 333.0 KB (3.87x) | 143.9 KB (1.67x) |
| script (ms) | **0.4** | 10.7 (26.42x) | 13.8 (34.09x) | 1.3 (3.14x) | 18.8 (46.51x) | 5.3 (13.17x) |
| style (ms) | 5.7 (1.06x) | 5.5 (1.02x) | **5.4** | 5.5 (1.02x) | 5.9 (1.10x) | 5.8 (1.09x) |
| layout (ms) | 26.0 (1.00x) | 26.4 (1.02x) | 26.1 (1.01x) | 26.1 (1.00x) | 27.0 (1.04x) | **26.0** |
| JS heap | **1046.0 KB** | 3192.9 KB (3.05x) | 3347.8 KB (3.20x) | 1306.9 KB (1.25x) | 4179.6 KB (4.00x) | 3862.4 KB (3.69x) |

## Table page in Chromium

|  | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| JS shipped (gzip) | 12.9 KB (1.59x) | **8.2 KB** | 22.5 KB (2.76x) | 9.6 KB (1.17x) | 134.3 KB (16.46x) | 71.8 KB (8.80x) |
| JS shipped (raw) | 31.5 KB (1.52x) | **20.8 KB** | 59.4 KB (2.86x) | 23.1 KB (1.11x) | 448.0 KB (21.59x) | 185.3 KB (8.93x) |
| JS files | 3 | 1 | 1 | 3 | 6 | 6 |
| HTML (gzip) | 1.0 KB (2.13x) | 0.7 KB (1.57x) | **0.5 KB** | 2.7 KB (5.83x) | 2.0 KB (4.29x) | 0.9 KB (1.94x) |
| HTML (raw) | 2.0 KB (2.25x) | 1.3 KB (1.48x) | **0.9 KB** | 6.4 KB (7.32x) | 6.2 KB (7.06x) | 2.1 KB (2.44x) |
| script (ms) | **1.1** | 2.2 (2.02x) | 3.9 (3.62x) | 1.9 (1.77x) | 9.7 (8.98x) | 4.5 (4.17x) |
| style (ms) | 0.4 (2.59x) | 0.2 (1.02x) | **0.2** | 0.2 (1.14x) | 0.2 (1.42x) | 0.2 (1.18x) |
| layout (ms) | 2.5 (1.12x) | 2.2 (1.00x) | **2.2** | 2.3 (1.04x) | 2.5 (1.15x) | 2.3 (1.06x) |
| JS heap | **1434.6 KB** | 1726.2 KB (1.20x) | 1805.6 KB (1.26x) | 1728.0 KB (1.20x) | 2888.6 KB (2.01x) | 2113.4 KB (1.47x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| create 1,000 rows | 29.2 (1.12x) | **26.1** | 27.6 (1.06x) | 26.7 (1.02x) | 29.6 (1.13x) | 26.9 (1.03x) |
| replace 1,000 rows | 25.7 (1.04x) | 24.7 (1.00x) | 25.7 (1.04x) | **24.7** | 29.8 (1.21x) | 27.5 (1.12x) |
| update every 10th row | 2.9 (1.10x) | 2.7 (1.04x) | **2.6** | 2.7 (1.04x) | 4.0 (1.54x) | 3.5 (1.35x) |
| select row | **0.2** | 0.3 (1.50x) | 0.9 (4.75x) | 0.3 (1.50x) | 1.2 (6.00x) | 0.6 (3.25x) |
| swap rows | 2.3 (1.18x) | 2.0 (1.03x) | 2.1 (1.08x) | **1.9** | 20.4 (10.46x) | 2.4 (1.23x) |
| remove row | 2.1 (1.11x) | 1.9 (1.03x) | 2.2 (1.16x) | **1.9** | 3.2 (1.68x) | 4.5 (2.34x) |
| create 10,000 rows | 262 (1.15x) | **227** | 230 (1.01x) | 236 (1.04x) | 363 (1.60x) | 267 (1.17x) |
| append 1,000 rows | 24.2 (1.03x) | 23.6 (1.01x) | 23.9 (1.02x) | **23.4** | 26.6 (1.14x) | 25.8 (1.10x) |
| clear 1,000 rows | 2.9 (1.09x) | **2.7** | 3.2 (1.19x) | 2.8 (1.02x) | 5.0 (1.85x) | 4.3 (1.57x) |
