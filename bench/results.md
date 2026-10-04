# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay on solid-js 2.0.0-rc.13, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-04

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | 2978 (1.27x) | 1713 (2.20x) | **3770** |
| mean (ms) | 0.3 (1.27x) | 0.6 (2.20x) | **0.3** |
| p50 (ms) | 0.3 (1.22x) | 0.5 (2.16x) | **0.2** |
| p99 (ms) | 0.8 (1.11x) | 1.7 (2.24x) | **0.7** |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 28.5 KB (3.56x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 74.6 KB (3.67x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | **8.3 KB** | 21.6 KB (2.61x) | 15.6 KB (1.89x) |
| HTML (raw) | **85.6 KB** | 171.8 KB (2.01x) | 138.6 KB (1.62x) |
| script (ms) | **1.3** | 10.5 (8.31x) | 15.9 (12.54x) |
| style (ms) | 5.8 (1.06x) | **5.5** | 6.3 (1.13x) |
| layout (ms) | **27.4** | 27.5 (1.00x) | 31.1 (1.13x) |
| JS heap | **1385.9 KB** | 2984.4 KB (2.15x) | 3125.2 KB (2.25x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 29.4 KB (3.68x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 76.7 KB (3.77x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | 0.8 KB (1.90x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.6 KB (1.87x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **2.0** | 2.5 (1.27x) | 4.7 (2.39x) |
| style (ms) | 0.4 (2.25x) | **0.2** | 0.2 (1.07x) |
| layout (ms) | 2.8 (1.16x) | **2.4** | 2.9 (1.19x) |
| JS heap | 1810.2 KB (1.15x) | **1573.4 KB** | 1592.3 KB (1.01x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 30.9 (1.14x) | **27.1** | 32.6 (1.20x) |
| replace 1,000 rows | **27.2** | 28.6 (1.05x) | 30.1 (1.11x) |
| update every 10th row | 3.6 (1.12x) | 3.3 (1.02x) | **3.2** |
| select row | **0.2** | 0.3 (1.50x) | 1.1 (5.50x) |
| swap rows | **2.4** | 2.4 (1.02x) | 2.5 (1.02x) |
| remove row | 2.5 (1.07x) | **2.3** | 2.4 (1.07x) |
| create 10,000 rows | 249 (1.08x) | **231** | 235 (1.02x) |
| append 1,000 rows | **26.0** | 28.5 (1.10x) | 28.8 (1.11x) |
| clear 1,000 rows | 3.4 (1.05x) | **3.3** | 3.8 (1.17x) |
