# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 1.0.0, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-06

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | **4454** | 1703 (2.62x) | 3519 (1.27x) |
| mean (ms) | **0.2** | 0.6 (2.62x) | 0.3 (1.27x) |
| p50 (ms) | **0.2** | 0.5 (2.73x) | 0.3 (1.35x) |
| p99 (ms) | **0.8** | 1.6 (2.05x) | 0.8 (1.06x) |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 12.0 KB (1.50x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 28.2 KB (1.39x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 5 | 1 | 1 |
| HTML (gzip) | **8.1 KB** | 21.6 KB (2.66x) | 15.6 KB (1.93x) |
| HTML (raw) | **85.4 KB** | 171.8 KB (2.01x) | 138.6 KB (1.62x) |
| script (ms) | **1.7** | 11.8 (6.83x) | 15.4 (8.92x) |
| style (ms) | **5.7** | 6.4 (1.13x) | 6.2 (1.09x) |
| layout (ms) | **27.3** | 32.3 (1.18x) | 31.3 (1.15x) |
| JS heap | **1264.6 KB** | 2978.7 KB (2.36x) | 3124.9 KB (2.47x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 13.0 KB (1.62x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 30.4 KB (1.50x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 5 | 1 | 1 |
| HTML (gzip) | 0.7 KB (1.62x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.4 KB (1.68x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **1.9** | 2.5 (1.32x) | 4.5 (2.31x) |
| style (ms) | 0.3 (1.94x) | **0.2** | 0.2 (1.01x) |
| layout (ms) | **2.5** | 2.7 (1.07x) | 2.7 (1.08x) |
| JS heap | 1654.2 KB (1.07x) | **1548.3 KB** | 1587.0 KB (1.03x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 32.2 (1.05x) | **30.8** | 32.3 (1.05x) |
| replace 1,000 rows | **27.0** | 29.6 (1.10x) | 31.2 (1.16x) |
| update every 10th row | 3.6 (1.18x) | 3.3 (1.07x) | **3.0** |
| select row | **0.1** | 0.3 (3.00x) | 1.2 (12.00x) |
| swap rows | 2.6 (1.13x) | **2.3** | 2.4 (1.04x) |
| remove row | **2.2** | 2.3 (1.05x) | 2.5 (1.14x) |
| create 10,000 rows | 264 (1.13x) | 260 (1.11x) | **233** |
| append 1,000 rows | **27.4** | 28.6 (1.04x) | 28.3 (1.03x) |
| clear 1,000 rows | **3.2** | 3.4 (1.05x) | 3.8 (1.17x) |
