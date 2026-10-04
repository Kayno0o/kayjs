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
| renders/s | **5041** | 1745 (2.89x) | 3853 (1.31x) |
| mean (ms) | **0.2** | 0.6 (2.89x) | 0.3 (1.31x) |
| p50 (ms) | **0.2** | 0.5 (2.93x) | 0.2 (1.37x) |
| p99 (ms) | **0.7** | 1.6 (2.30x) | 0.7 (1.08x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 28.5 KB (3.56x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 74.6 KB (3.67x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | **8.3 KB** | 21.6 KB (2.61x) | 15.6 KB (1.89x) |
| HTML (raw) | **85.6 KB** | 171.8 KB (2.01x) | 138.6 KB (1.62x) |
| script (ms) | **1.3** | 12.6 (9.39x) | 15.7 (11.65x) |
| style (ms) | 6.7 (1.07x) | 6.4 (1.02x) | **6.3** |
| layout (ms) | 31.4 (1.00x) | 31.8 (1.01x) | **31.4** |
| JS heap | **1385.9 KB** | 2996.9 KB (2.16x) | 3133.8 KB (2.26x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 29.4 KB (3.68x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 76.7 KB (3.77x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | 0.8 KB (1.90x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.6 KB (1.87x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **2.2** | 2.8 (1.29x) | 4.6 (2.14x) |
| style (ms) | 0.4 (2.50x) | 0.2 (1.02x) | **0.2** |
| layout (ms) | 3.2 (1.13x) | **2.8** | 2.9 (1.02x) |
| JS heap | 1799.0 KB (1.14x) | **1571.6 KB** | 1593.5 KB (1.01x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 35.4 (1.14x) | **31.2** | 32.4 (1.04x) |
| replace 1,000 rows | 30.8 (1.03x) | **29.9** | 30.9 (1.04x) |
| update every 10th row | 3.9 (1.22x) | 3.3 (1.03x) | **3.2** |
| select row | **0.3** | 0.4 (1.60x) | 1.2 (4.80x) |
| swap rows | 2.9 (1.26x) | **2.3** | 2.5 (1.09x) |
| remove row | 2.9 (1.36x) | **2.1** | 2.6 (1.24x) |
| create 10,000 rows | 273 (1.21x) | **224** | 242 (1.08x) |
| append 1,000 rows | 29.8 (1.03x) | **28.8** | 29.0 (1.01x) |
| clear 1,000 rows | 3.6 (1.09x) | **3.3** | 3.7 (1.14x) |
