# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 1.3.0, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-07

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | **4752** | 1753 (2.71x) | 3751 (1.27x) |
| mean (ms) | **0.2** | 0.6 (2.71x) | 0.3 (1.27x) |
| p50 (ms) | **0.2** | 0.5 (2.79x) | 0.2 (1.33x) |
| p99 (ms) | **0.7** | 1.6 (2.27x) | 0.7 (1.05x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 9.7 KB (1.21x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 22.1 KB (1.09x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 5 | 1 | 1 |
| HTML (gzip) | **8.1 KB** | 21.6 KB (2.66x) | 15.6 KB (1.92x) |
| HTML (raw) | **85.4 KB** | 171.8 KB (2.01x) | 138.6 KB (1.62x) |
| script (ms) | **1.8** | 12.6 (6.98x) | 15.3 (8.51x) |
| style (ms) | 6.7 (1.08x) | 6.3 (1.02x) | **6.2** |
| layout (ms) | **30.6** | 31.6 (1.03x) | 31.0 (1.01x) |
| JS heap | **1262.6 KB** | 2981.5 KB (2.36x) | 3127.6 KB (2.48x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 10.6 KB (1.33x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 24.3 KB (1.20x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 5 | 1 | 1 |
| HTML (gzip) | 0.7 KB (1.62x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.4 KB (1.68x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **2.1** | 2.5 (1.19x) | 4.5 (2.13x) |
| style (ms) | 0.4 (2.20x) | 0.2 (1.05x) | **0.2** |
| layout (ms) | 2.8 (1.04x) | **2.7** | 2.7 (1.01x) |
| JS heap | 1654.7 KB (1.05x) | **1572.1 KB** | 1593.1 KB (1.01x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 31.0 (1.01x) | **30.7** | 32.4 (1.05x) |
| replace 1,000 rows | **29.4** | 29.8 (1.01x) | 31.3 (1.06x) |
| update every 10th row | 3.5 (1.17x) | 3.1 (1.03x) | **3.0** |
| select row | **0.1** | 0.4 (2.67x) | 1.2 (8.00x) |
| swap rows | 2.5 (1.14x) | **2.2** | 2.5 (1.14x) |
| remove row | **2.2** | 2.2 (1.02x) | 2.5 (1.16x) |
| create 10,000 rows | 277 (1.07x) | **259** | 261 (1.01x) |
| append 1,000 rows | 27.5 (1.04x) | 28.3 (1.07x) | **26.5** |
| clear 1,000 rows | **3.3** | 3.3 (1.02x) | 3.7 (1.12x) |
