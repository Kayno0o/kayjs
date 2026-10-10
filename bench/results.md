# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 1.24.4, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-10

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | **3960** | 1578 (2.51x) | 3215 (1.23x) |
| mean (ms) | **0.3** | 0.6 (2.51x) | 0.3 (1.23x) |
| p50 (ms) | **0.2** | 0.6 (2.61x) | 0.3 (1.29x) |
| p99 (ms) | **0.9** | 1.8 (2.08x) | 0.9 (1.10x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 10.2 KB (1.25x) | **8.2 KB** | 22.5 KB (2.76x) |
| JS shipped (raw) | 25.1 KB (1.21x) | **20.8 KB** | 59.4 KB (2.86x) |
| JS files | 2 | 1 | 1 |
| HTML (gzip) | **8.2 KB** | 21.6 KB (2.63x) | 15.7 KB (1.91x) |
| HTML (raw) | **85.5 KB** | 171.8 KB (2.01x) | 138.7 KB (1.62x) |
| script (ms) | **0.3** | 10.9 (32.92x) | 14.5 (43.90x) |
| style (ms) | 5.7 (1.03x) | **5.5** | 5.8 (1.06x) |
| layout (ms) | 28.8 (1.00x) | **28.8** | 28.9 (1.00x) |
| JS heap | **872.4 KB** | 3017.3 KB (3.46x) | 3146.1 KB (3.61x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 11.2 KB (1.37x) | **8.2 KB** | 22.5 KB (2.76x) |
| JS shipped (raw) | 27.3 KB (1.32x) | **20.8 KB** | 59.4 KB (2.86x) |
| JS files | 2 | 1 | 1 |
| HTML (gzip) | 0.8 KB (1.74x) | 0.7 KB (1.57x) | **0.5 KB** |
| HTML (raw) | 1.6 KB (1.79x) | 1.3 KB (1.48x) | **0.9 KB** |
| script (ms) | **1.1** | 2.4 (2.25x) | 5.0 (4.69x) |
| style (ms) | 0.4 (2.33x) | **0.2** | 0.2 (1.30x) |
| layout (ms) | 2.7 (1.12x) | **2.4** | 2.9 (1.21x) |
| JS heap | **1256.4 KB** | 1588.7 KB (1.26x) | 1628.6 KB (1.30x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 33.5 (1.18x) | **28.6** | 29.6 (1.04x) |
| replace 1,000 rows | 28.8 (1.09x) | **26.3** | 28.0 (1.06x) |
| update every 10th row | 3.3 (1.12x) | 3.8 (1.29x) | **3.0** |
| select row | **0.2** | 0.5 (2.50x) | 1.0 (5.00x) |
| swap rows | 2.5 (1.04x) | **2.4** | 2.8 (1.15x) |
| remove row | 2.3 (1.07x) | **2.2** | 2.3 (1.07x) |
| create 10,000 rows | 242 (1.06x) | **228** | 239 (1.05x) |
| append 1,000 rows | **23.8** | 25.8 (1.08x) | 25.3 (1.06x) |
| clear 1,000 rows | 3.3 (1.10x) | **3.0** | 3.5 (1.15x) |
