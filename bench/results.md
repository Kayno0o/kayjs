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
| renders/s | **4788** | 1754 (2.73x) | 3853 (1.24x) |
| mean (ms) | **0.2** | 0.6 (2.73x) | 0.3 (1.24x) |
| p50 (ms) | **0.2** | 0.5 (2.77x) | 0.2 (1.30x) |
| p99 (ms) | **0.7** | 1.6 (2.31x) | 0.7 (1.05x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 8.7 KB (1.09x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 21.4 KB (1.05x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 2 | 1 | 1 |
| HTML (gzip) | **8.1 KB** | 21.6 KB (2.67x) | 15.6 KB (1.93x) |
| HTML (raw) | **85.3 KB** | 171.8 KB (2.01x) | 138.6 KB (1.63x) |
| script (ms) | **0.4** | 12.4 (32.23x) | 15.6 (40.38x) |
| style (ms) | 6.5 (1.04x) | 6.4 (1.03x) | **6.3** |
| layout (ms) | 31.6 (1.02x) | 31.9 (1.03x) | **31.1** |
| JS heap | **1248.0 KB** | 3008.3 KB (2.41x) | 3122.3 KB (2.50x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 9.7 KB (1.21x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 23.5 KB (1.16x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 2 | 1 | 1 |
| HTML (gzip) | 0.7 KB (1.56x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.3 KB (1.55x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **1.2** | 2.6 (2.14x) | 4.6 (3.83x) |
| style (ms) | 0.4 (2.57x) | **0.2** | 0.2 (1.03x) |
| layout (ms) | 2.9 (1.09x) | **2.7** | 2.7 (1.01x) |
| JS heap | 1638.1 KB (1.03x) | **1596.0 KB** | 1627.3 KB (1.02x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 31.1 (1.05x) | **29.7** | 32.3 (1.09x) |
| replace 1,000 rows | 29.5 (1.01x) | **29.1** | 30.3 (1.04x) |
| update every 10th row | 3.6 (1.20x) | 3.1 (1.02x) | **3.0** |
| select row | **0.2** | 0.3 (1.50x) | 1.1 (5.50x) |
| swap rows | 2.5 (1.19x) | 2.2 (1.02x) | **2.1** |
| remove row | 2.3 (1.05x) | **2.2** | 2.5 (1.14x) |
| create 10,000 rows | **250** | 256 (1.02x) | 256 (1.02x) |
| append 1,000 rows | **27.4** | 28.2 (1.03x) | 27.9 (1.02x) |
| clear 1,000 rows | 3.3 (1.06x) | **3.1** | 3.6 (1.16x) |
