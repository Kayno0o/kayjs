# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 0.14.0, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-06

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | **4753** | 1744 (2.73x) | 3816 (1.25x) |
| mean (ms) | **0.2** | 0.6 (2.73x) | 0.3 (1.25x) |
| p50 (ms) | **0.2** | 0.5 (2.83x) | 0.2 (1.31x) |
| p99 (ms) | **0.7** | 1.6 (2.23x) | 0.7 (1.04x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 13.6 KB (1.69x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 31.8 KB (1.57x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 5 | 1 | 1 |
| HTML (gzip) | **8.1 KB** | 21.6 KB (2.66x) | 15.6 KB (1.92x) |
| HTML (raw) | **85.4 KB** | 171.8 KB (2.01x) | 138.6 KB (1.62x) |
| script (ms) | **1.9** | 12.3 (6.62x) | 15.2 (8.15x) |
| style (ms) | 6.8 (1.18x) | **5.8** | 6.4 (1.11x) |
| layout (ms) | 31.1 (1.05x) | **29.5** | 30.5 (1.04x) |
| JS heap | **1267.3 KB** | 2991.9 KB (2.36x) | 3130.5 KB (2.47x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 14.5 KB (1.81x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 34.0 KB (1.67x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 5 | 1 | 1 |
| HTML (gzip) | 0.7 KB (1.62x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.4 KB (1.68x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **2.1** | 2.5 (1.21x) | 4.0 (1.92x) |
| style (ms) | 0.4 (2.33x) | 0.2 (1.01x) | **0.2** |
| layout (ms) | 2.8 (1.08x) | 2.6 (1.01x) | **2.6** |
| JS heap | 1652.6 KB (1.05x) | **1579.3 KB** | 1596.5 KB (1.01x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | **31.1** | 31.5 (1.02x) | 31.4 (1.01x) |
| replace 1,000 rows | 29.7 (1.03x) | **28.8** | 30.4 (1.05x) |
| update every 10th row | 3.6 (1.18x) | **3.0** | 3.1 (1.02x) |
| select row | **0.2** | 0.3 (1.50x) | 1.2 (5.75x) |
| swap rows | 2.6 (1.18x) | **2.2** | 2.4 (1.09x) |
| remove row | **2.2** | 2.2 (1.00x) | 2.4 (1.07x) |
| create 10,000 rows | 256 (1.02x) | **251** | 281 (1.12x) |
| append 1,000 rows | 26.5 (1.05x) | 28.9 (1.15x) | **25.2** |
| clear 1,000 rows | 3.2 (1.03x) | **3.1** | 3.6 (1.16x) |
