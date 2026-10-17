# Benchmark: kay, SolidJS, Svelte, Astro, Next.js and Nuxt

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.3, Chromium 151.0.7922.34 headless
- kay 1.51.0, solid-js 1.9.15, svelte 5.57.1, astro 7.3.8, next 16.4.0, nuxt 4.6.1
- run on 2026-10-17, each value the median of 3 runs

Every app renders the same markup from the same data, checked before measuring, table rows included: kay, Solid and Svelte behind the same Elysia server, Astro and Nuxt through their own request handlers called in-process, Next through its Node request handler on a local port. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Nuxt hydrates the whole page too, the products coming from an API route into its payload. Astro hydrates its counter and table as SolidJS islands. Next renders server components and hydrates its client ones, the counter and table, streaming the component payload with the page.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`. Astro's island is the Solid table, Next keeps rows and selection in one reducer with memoised rows, Nuxt keeps a shallow ref of plain rows memoised with `v-memo`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata. Next is left out: it serves only through its own HTTP server, so its renders would carry a socket round trip the others never pay.

|  | kay | solid | svelte | astro | nuxt |
| --- | --- | --- | --- | --- | --- |
| renders/s | **4286** | 1712 (2.50x) | 3806 (1.13x) | 1805 (2.38x) | 581 (7.37x) |
| mean (ms) | **0.2** | 0.6 (2.50x) | 0.3 (1.13x) | 0.6 (2.38x) | 1.7 (7.37x) |
| p50 (ms) | **0.2** | 0.5 (2.33x) | 0.2 (1.07x) | 0.5 (2.18x) | 1.5 (6.81x) |
| p99 (ms) | **0.4** | 1.6 (4.36x) | 0.8 (2.07x) | 1.3 (3.42x) | 3.8 (10.39x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| JS shipped (gzip) | 10.7 KB (1.31x) | **8.2 KB** | 22.5 KB (2.76x) | 8.6 KB (1.05x) | 133.3 KB (16.34x) | 75.9 KB (9.31x) |
| JS shipped (raw) | 26.5 KB (1.28x) | **20.8 KB** | 59.4 KB (2.86x) | 21.0 KB (1.01x) | 445.4 KB (21.46x) | 196.4 KB (9.47x) |
| JS files | 2 | 1 | 1 | 3 | 6 | 6 |
| HTML (gzip) | **8.4 KB** | 21.6 KB (2.57x) | 15.7 KB (1.87x) | 10.3 KB (1.23x) | 23.6 KB (2.81x) | 23.5 KB (2.80x) |
| HTML (raw) | **85.9 KB** | 171.8 KB (2.00x) | 138.7 KB (1.61x) | 90.4 KB (1.05x) | 333.0 KB (3.88x) | 143.9 KB (1.68x) |
| script (ms) | **0.2** | 10.8 (44.09x) | 14.2 (58.05x) | 1.3 (5.27x) | 18.6 (75.96x) | 5.5 (22.35x) |
| style (ms) | 5.7 (1.08x) | 5.4 (1.04x) | **5.2** | 5.6 (1.06x) | 5.9 (1.13x) | 5.9 (1.13x) |
| layout (ms) | **25.8** | 26.4 (1.02x) | 26.1 (1.01x) | 26.1 (1.01x) | 27.1 (1.05x) | 26.2 (1.01x) |
| JS heap | **1034.2 KB** | 3194.3 KB (3.09x) | 3336.8 KB (3.23x) | 1306.9 KB (1.26x) | 4180.0 KB (4.04x) | 3857.3 KB (3.73x) |

## Table page in Chromium

|  | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| JS shipped (gzip) | 11.7 KB (1.43x) | **8.2 KB** | 22.5 KB (2.76x) | 9.6 KB (1.17x) | 134.3 KB (16.46x) | 71.8 KB (8.80x) |
| JS shipped (raw) | 28.7 KB (1.38x) | **20.8 KB** | 59.4 KB (2.86x) | 23.1 KB (1.11x) | 448.0 KB (21.59x) | 185.3 KB (8.93x) |
| JS files | 2 | 1 | 1 | 3 | 6 | 6 |
| HTML (gzip) | 0.9 KB (2.07x) | 0.7 KB (1.57x) | **0.5 KB** | 2.7 KB (5.83x) | 2.0 KB (4.29x) | 0.9 KB (1.94x) |
| HTML (raw) | 1.9 KB (2.17x) | 1.3 KB (1.48x) | **0.9 KB** | 6.4 KB (7.33x) | 6.2 KB (7.06x) | 2.1 KB (2.44x) |
| script (ms) | **1.0** | 2.2 (2.33x) | 4.0 (4.20x) | 1.9 (2.01x) | 12.4 (13.03x) | 4.4 (4.66x) |
| style (ms) | 0.4 (2.34x) | 0.2 (1.01x) | **0.2** | 0.2 (1.14x) | 0.2 (1.33x) | 0.2 (1.05x) |
| layout (ms) | 2.4 (1.07x) | **2.2** | 2.2 (1.01x) | 2.3 (1.03x) | 2.5 (1.12x) | 2.3 (1.05x) |
| JS heap | **1417.5 KB** | 1758.1 KB (1.24x) | 1810.2 KB (1.28x) | 1729.2 KB (1.22x) | 2878.5 KB (2.03x) | 2107.4 KB (1.49x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte | astro | next | nuxt |
| --- | --- | --- | --- | --- | --- | --- |
| create 1,000 rows | 29.8 (1.16x) | 26.7 (1.04x) | **25.8** | 26.6 (1.03x) | 29.9 (1.16x) | 27.0 (1.05x) |
| replace 1,000 rows | 25.7 (1.04x) | **24.6** | 25.9 (1.05x) | 24.8 (1.01x) | 31.4 (1.27x) | 27.9 (1.13x) |
| update every 10th row | 2.8 (1.06x) | 2.7 (1.02x) | 2.7 (1.02x) | **2.6** | 4.1 (1.53x) | 3.4 (1.28x) |
| select row | **0.2** | 0.3 (1.50x) | 1.0 (5.00x) | 0.3 (1.50x) | 1.2 (6.00x) | 0.7 (3.50x) |
| swap rows | 2.3 (1.21x) | 2.0 (1.05x) | 2.1 (1.11x) | **1.9** | 20.4 (10.74x) | 2.4 (1.26x) |
| remove row | 2.0 (1.11x) | 2.0 (1.11x) | 2.2 (1.22x) | **1.8** | 3.4 (1.89x) | 4.5 (2.47x) |
| create 10,000 rows | 264 (1.15x) | **228** | 232 (1.02x) | 236 (1.03x) | 362 (1.59x) | 267 (1.17x) |
| append 1,000 rows | 24.5 (1.05x) | **23.3** | 24.0 (1.03x) | 23.6 (1.02x) | 26.9 (1.15x) | 25.6 (1.10x) |
| clear 1,000 rows | 3.0 (1.11x) | 2.8 (1.04x) | 3.2 (1.19x) | **2.7** | 5.0 (1.85x) | 4.1 (1.52x) |
