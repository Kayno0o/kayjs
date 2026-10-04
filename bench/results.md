# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 0.2.0, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-04

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | **4085** | 1599 (2.56x) | 3794 (1.08x) |
| mean (ms) | **0.2** | 0.6 (2.56x) | 0.3 (1.08x) |
| p50 (ms) | **0.2** | 0.5 (2.69x) | 0.2 (1.21x) |
| p99 (ms) | 0.9 (1.18x) | 1.8 (2.26x) | **0.8** |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | **6.6 KB** | 8.0 KB (1.22x) | 21.8 KB (3.33x) |
| JS shipped (raw) | **14.5 KB** | 20.3 KB (1.40x) | 57.6 KB (3.98x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | **8.1 KB** | 21.6 KB (2.66x) | 15.6 KB (1.93x) |
| HTML (raw) | **85.3 KB** | 171.8 KB (2.01x) | 138.6 KB (1.62x) |
| script (ms) | **1.1** | 14.2 (12.58x) | 16.0 (14.14x) |
| style (ms) | 6.6 (1.05x) | 6.4 (1.03x) | **6.2** |
| layout (ms) | **30.9** | 32.1 (1.04x) | 31.9 (1.03x) |
| JS heap | **1193.9 KB** | 3017.9 KB (2.53x) | 3126.7 KB (2.62x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | **7.5 KB** | 8.0 KB (1.06x) | 21.8 KB (2.90x) |
| JS shipped (raw) | **16.7 KB** | 20.3 KB (1.22x) | 57.6 KB (3.46x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | 0.7 KB (1.60x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.4 KB (1.61x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **1.9** | 2.9 (1.55x) | 4.8 (2.58x) |
| style (ms) | 0.4 (2.05x) | 0.2 (1.01x) | **0.2** |
| layout (ms) | 3.1 (1.11x) | **2.8** | 2.8 (1.01x) |
| JS heap | **1581.3 KB** | 1607.0 KB (1.02x) | 1633.9 KB (1.03x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 32.2 (1.04x) | **31.1** | 32.4 (1.04x) |
| replace 1,000 rows | **28.3** | 29.6 (1.04x) | 30.1 (1.06x) |
| update every 10th row | 3.7 (1.21x) | 3.3 (1.05x) | **3.1** |
| select row | **0.2** | 0.3 (1.50x) | 1.1 (5.25x) |
| swap rows | 2.6 (1.11x) | **2.3** | 2.4 (1.02x) |
| remove row | 2.3 (1.05x) | **2.2** | 2.6 (1.18x) |
| create 10,000 rows | 243 (1.06x) | **229** | 232 (1.01x) |
| append 1,000 rows | **27.1** | 27.5 (1.01x) | 28.2 (1.04x) |
| clear 1,000 rows | 3.3 (1.02x) | **3.2** | 4.0 (1.23x) |
