# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay on solid-js 2.0.0-rc.13, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-03

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | 1973 (1.96x) | 1689 (2.29x) | **3872** |
| mean (ms) | 0.5 (1.96x) | 0.6 (2.29x) | **0.3** |
| p50 (ms) | 0.4 (1.83x) | 0.5 (2.21x) | **0.2** |
| p99 (ms) | 1.1 (1.55x) | 1.7 (2.31x) | **0.7** |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 26.5 KB (3.31x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 69.4 KB (3.42x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | **8.4 KB** | 21.6 KB (2.56x) | 15.6 KB (1.86x) |
| HTML (raw) | **93.4 KB** | 171.8 KB (1.84x) | 138.6 KB (1.48x) |
| script (ms) | **1.4** | 13.3 (9.73x) | 16.1 (11.83x) |
| style (ms) | 6.9 (1.07x) | 6.5 (1.01x) | **6.4** |
| layout (ms) | 31.9 (1.02x) | 31.9 (1.03x) | **31.1** |
| JS heap | **1369.0 KB** | 2980.6 KB (2.18x) | 3129.4 KB (2.29x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 27.5 KB (3.44x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 71.5 KB (3.52x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | 0.9 KB (1.91x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.6 KB (1.88x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **2.0** | 2.8 (1.37x) | 4.7 (2.34x) |
| style (ms) | 0.4 (2.24x) | 0.2 (1.15x) | **0.2** |
| layout (ms) | 3.2 (1.13x) | **2.9** | 2.9 (1.00x) |
| JS heap | 1775.3 KB (1.14x) | **1564.1 KB** | 1591.3 KB (1.02x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 33.8 (1.08x) | **31.1** | 32.8 (1.05x) |
| replace 1,000 rows | 32.3 (1.07x) | **30.1** | 31.2 (1.03x) |
| update every 10th row | 4.0 (1.23x) | 3.3 (1.02x) | **3.2** |
| select row | **0.3** | 0.3 (1.00x) | 1.2 (4.00x) |
| swap rows | 2.5 (1.06x) | **2.4** | 2.6 (1.06x) |
| remove row | 2.8 (1.20x) | **2.3** | 2.6 (1.13x) |
| create 10,000 rows | 267 (1.12x) | 251 (1.05x) | **238** |
| append 1,000 rows | 30.6 (1.06x) | **28.8** | 29.6 (1.03x) |
| clear 1,000 rows | 3.6 (1.16x) | **3.1** | 3.6 (1.18x) |
