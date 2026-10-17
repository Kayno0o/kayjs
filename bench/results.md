# Benchmark: kay, SolidJS, Svelte, Astro, Next.js and Nuxt

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.3, Chromium 151.0.7922.34 headless
- kay 1.51.1, solid-js 1.9.15, svelte 5.57.1, astro 7.3.8, next 16.4.0, nuxt 4.6.1
- run on 2026-10-17, each value the median of 3 runs

Every app renders the same markup from the same data, checked before measuring, table rows included: kay, Solid and Svelte behind the same Elysia server, Astro and Nuxt through their own request handlers called in-process, Next through its Node request handler on a local port. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Nuxt hydrates the whole page too, the products coming from an API route into its payload. Astro hydrates its counter and table as SolidJS islands. Next renders server components and hydrates its client ones, the counter and table, streaming the component payload with the page.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`. Astro's island is the Solid table, Next keeps rows and selection in one reducer with memoised rows, Nuxt keeps a shallow ref of plain rows memoised with `v-memo`.

## Build

A clean production build of each app, run 3 times before anything else is timed, the wall time the median. kay is built as `kay build` runs it, `kay check` included, and with `--no-check`, as `astro build` and the rest check nothing (Next's build type-checks the app as it goes). Size is what the build deploys, server and client output, without the dependencies it runs on, source maps and the precompressed copies kay writes beside its files; gzip is each file compressed alone.

|  | kay | kay --no-check | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| build time | 0.80 s (8.83x) | 0.34 s (3.81x) | 0.14 s (1.61x) | **0.09 s** | 0.67 s (7.43x) | 2.14 s (23.75x) | 1.94 s (21.47x) |
| output (gzip) | 33.4 KB (4.09x) | 33.4 KB (4.09x) | **8.2 KB** | 22.5 KB (2.76x) | 138.0 KB (16.93x) | 328.9 KB (40.32x) | 610.7 KB (74.88x) |
| output (raw) | 143.1 KB (6.90x) | 143.1 KB (6.90x) | **20.8 KB** | 59.4 KB (2.86x) | 485.1 KB (23.38x) | 1041.4 KB (50.19x) | 2277.8 KB (109.77x) |
| output files | 17 | 17 | 1 | 1 | 18 | 105 | 133 |

What is counted:

- kay: `.kay/client/dist` (the browser bundle, a chunk per island) and `.kay/client/pages` (the prerendered pages). Its server is not bundled: Bun runs the app's sources, so it adds nothing here.
- Solid and Svelte: `dist`, the browser bundle `Bun.build` writes. Their server code is compiled in memory as the server starts, so it adds nothing here.
- Astro: `dist`, its server entry and its client assets. Next: `.next` without `cache`, `diagnostics`, `types` and the build traces and file lists; its server needs `next` from `node_modules` to run. Nuxt: `.output`, the Nitro server with the dependencies it traced, and `public`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata. Next is left out: it serves only through its own HTTP server, so its renders would carry a socket round trip the others never pay.

|  | kay | solid | svelte | astro | nuxt |
| --- | --- | --- | --- | --- | --- |
| renders/s | **4320** | 1738 (2.49x) | 3871 (1.12x) | 1804 (2.39x) | 582 (7.42x) |
| mean (ms) | **0.2** | 0.6 (2.49x) | 0.3 (1.12x) | 0.6 (2.39x) | 1.7 (7.42x) |
| p50 (ms) | **0.2** | 0.5 (2.32x) | 0.2 (1.06x) | 0.5 (2.18x) | 1.5 (6.83x) |
| p99 (ms) | **0.4** | 1.6 (4.19x) | 0.7 (2.00x) | 1.3 (3.39x) | 3.8 (10.05x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| JS shipped (gzip) | 10.7 KB (1.31x) | **8.2 KB** | 22.5 KB (2.76x) | 8.6 KB (1.05x) | 133.3 KB (16.34x) | 75.9 KB (9.31x) |
| JS shipped (raw) | 26.5 KB (1.28x) | **20.8 KB** | 59.4 KB (2.86x) | 21.0 KB (1.01x) | 445.4 KB (21.46x) | 196.4 KB (9.47x) |
| JS files | 2 | 1 | 1 | 3 | 6 | 6 |
| HTML (gzip) | **8.4 KB** | 21.6 KB (2.57x) | 15.7 KB (1.87x) | 10.3 KB (1.23x) | 23.6 KB (2.81x) | 23.5 KB (2.80x) |
| HTML (raw) | **85.9 KB** | 171.8 KB (2.00x) | 138.7 KB (1.61x) | 90.4 KB (1.05x) | 333.0 KB (3.88x) | 143.9 KB (1.68x) |
| script (ms) | **0.3** | 11.1 (44.12x) | 13.9 (55.51x) | 1.3 (5.09x) | 19.2 (76.46x) | 5.2 (20.95x) |
| style (ms) | 5.6 (1.06x) | 5.4 (1.02x) | **5.3** | 5.5 (1.04x) | 5.8 (1.09x) | 5.8 (1.08x) |
| layout (ms) | 26.5 (1.00x) | 27.0 (1.02x) | 26.5 (1.00x) | 26.8 (1.01x) | 27.4 (1.04x) | **26.4** |
| JS heap | **1034.2 KB** | 3200.7 KB (3.09x) | 3338.2 KB (3.23x) | 1306.9 KB (1.26x) | 4175.8 KB (4.04x) | 3860.2 KB (3.73x) |

## Table page in Chromium

|  | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| JS shipped (gzip) | 11.7 KB (1.43x) | **8.2 KB** | 22.5 KB (2.76x) | 9.6 KB (1.17x) | 134.3 KB (16.46x) | 71.8 KB (8.80x) |
| JS shipped (raw) | 28.7 KB (1.38x) | **20.8 KB** | 59.4 KB (2.86x) | 23.1 KB (1.11x) | 448.0 KB (21.59x) | 185.3 KB (8.93x) |
| JS files | 2 | 1 | 1 | 3 | 6 | 6 |
| HTML (gzip) | 0.9 KB (2.07x) | 0.7 KB (1.57x) | **0.5 KB** | 2.7 KB (5.83x) | 2.0 KB (4.29x) | 0.9 KB (1.94x) |
| HTML (raw) | 1.9 KB (2.17x) | 1.3 KB (1.48x) | **0.9 KB** | 6.4 KB (7.33x) | 6.2 KB (7.06x) | 2.1 KB (2.44x) |
| script (ms) | **0.9** | 2.2 (2.36x) | 4.1 (4.49x) | 1.9 (2.06x) | 10.0 (10.82x) | 4.2 (4.59x) |
| style (ms) | 0.5 (3.00x) | 0.2 (1.02x) | **0.2** | 0.2 (1.12x) | 0.2 (1.38x) | 0.2 (1.12x) |
| layout (ms) | 2.4 (1.08x) | 2.3 (1.03x) | **2.2** | 2.2 (1.01x) | 2.7 (1.20x) | 2.5 (1.12x) |
| JS heap | **1418.6 KB** | 1734.6 KB (1.22x) | 1807.8 KB (1.27x) | 1724.9 KB (1.22x) | 2886.7 KB (2.03x) | 2106.9 KB (1.49x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| create 1,000 rows | 29.9 (1.13x) | 26.6 (1.01x) | 28.0 (1.06x) | **26.4** | 31.1 (1.18x) | 26.8 (1.02x) |
| replace 1,000 rows | 25.6 (1.03x) | 24.8 (1.00x) | 25.6 (1.04x) | **24.8** | 30.2 (1.22x) | 27.7 (1.12x) |
| update every 10th row | 2.8 (1.06x) | 2.7 (1.02x) | **2.6** | **2.6** | 4.2 (1.57x) | 3.5 (1.32x) |
| select row | **0.2** | 0.3 (1.50x) | 1.0 (5.00x) | 0.3 (1.50x) | 1.3 (6.50x) | 0.6 (3.25x) |
| swap rows | 2.3 (1.15x) | **2.0** | 2.1 (1.08x) | 2.0 (1.03x) | 20.6 (10.54x) | 2.4 (1.23x) |
| remove row | 2.0 (1.08x) | 2.0 (1.05x) | 2.2 (1.19x) | **1.9** | 3.3 (1.76x) | 4.5 (2.41x) |
| create 10,000 rows | 260 (1.14x) | 229 (1.01x) | 234 (1.03x) | **227** | 364 (1.60x) | 271 (1.19x) |
| append 1,000 rows | 24.5 (1.05x) | 23.4 (1.01x) | 24.2 (1.04x) | **23.3** | 27.0 (1.16x) | 25.5 (1.10x) |
| clear 1,000 rows | 3.0 (1.13x) | **2.6** | 3.2 (1.23x) | 2.9 (1.12x) | 5.1 (1.94x) | 4.2 (1.62x) |
