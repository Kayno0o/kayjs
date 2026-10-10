# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 1.23.1, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-10

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | **4458** | 1661 (2.68x) | 3825 (1.17x) |
| mean (ms) | **0.2** | 0.6 (2.68x) | 0.3 (1.17x) |
| p50 (ms) | **0.2** | 0.5 (2.75x) | 0.2 (1.24x) |
| p99 (ms) | 0.8 (1.05x) | 1.7 (2.34x) | **0.7** |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 10.1 KB (1.24x) | **8.2 KB** | 22.5 KB (2.76x) |
| JS shipped (raw) | 24.8 KB (1.20x) | **20.8 KB** | 59.4 KB (2.86x) |
| JS files | 2 | 1 | 1 |
| HTML (gzip) | **8.2 KB** | 21.6 KB (2.63x) | 15.7 KB (1.91x) |
| HTML (raw) | **85.5 KB** | 171.8 KB (2.01x) | 138.7 KB (1.62x) |
| script (ms) | **0.3** | 11.2 (33.79x) | 15.8 (47.73x) |
| style (ms) | 6.5 (1.15x) | **5.7** | 6.2 (1.10x) |
| layout (ms) | 31.3 (1.09x) | **28.7** | 31.7 (1.10x) |
| JS heap | **872.4 KB** | 3035.3 KB (3.48x) | 3147.1 KB (3.61x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 11.1 KB (1.36x) | **8.2 KB** | 22.5 KB (2.76x) |
| JS shipped (raw) | 27.0 KB (1.30x) | **20.8 KB** | 59.4 KB (2.86x) |
| JS files | 2 | 1 | 1 |
| HTML (gzip) | 0.8 KB (1.74x) | 0.7 KB (1.57x) | **0.5 KB** |
| HTML (raw) | 1.6 KB (1.79x) | 1.3 KB (1.48x) | **0.9 KB** |
| script (ms) | **1.0** | 2.7 (2.60x) | 4.9 (4.70x) |
| style (ms) | 0.4 (2.73x) | 0.2 (1.04x) | **0.2** |
| layout (ms) | 2.9 (1.11x) | **2.6** | 2.7 (1.04x) |
| JS heap | **1257.4 KB** | 1602.7 KB (1.27x) | 1663.6 KB (1.32x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 33.5 (1.08x) | **30.9** | 31.9 (1.03x) |
| replace 1,000 rows | **27.3** | 29.5 (1.08x) | 29.7 (1.09x) |
| update every 10th row | 3.3 (1.10x) | 3.2 (1.05x) | **3.1** |
| select row | **0.2** | 0.3 (1.50x) | 1.0 (5.00x) |
| swap rows | 2.6 (1.13x) | **2.3** | 2.3 (1.02x) |
| remove row | 2.3 (1.02x) | **2.3** | 2.5 (1.11x) |
| create 10,000 rows | 251 (1.07x) | 236 (1.00x) | **235** |
| append 1,000 rows | 27.7 (1.01x) | **27.4** | 28.0 (1.02x) |
| clear 1,000 rows | 3.4 (1.17x) | **2.9** | 3.7 (1.28x) |
