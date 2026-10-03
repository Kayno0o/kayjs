# Benchmark: kay, SolidJS and Svelte

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay on solid-js 2.0.0-rc.13, solid-js 1.9.15, svelte 5.57.1
- run on 2026-10-03

Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.

What differs by design:

- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.
- Each table is written the way its framework's js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and has no selector primitive, so selecting re-checks every row.

## Server rendering

The products page (layout, 500 products, one counter) rendered in-process through the app's request handler, measured by mitata.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| renders/s | 1898 (2.01x) | 1751 (2.17x) | **3808** |
| mean (ms) | 0.5 (2.01x) | 0.6 (2.17x) | **0.3** |
| p50 (ms) | 0.5 (1.90x) | 0.5 (2.13x) | **0.2** |
| p99 (ms) | 1.2 (1.63x) | 1.5 (2.07x) | **0.7** |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 26.3 KB (3.29x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 69.0 KB (3.39x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | **8.4 KB** | 21.6 KB (2.56x) | 15.6 KB (1.86x) |
| HTML (raw) | **93.4 KB** | 171.8 KB (1.84x) | 138.6 KB (1.48x) |
| script (ms) | **1.4** | 12.6 (9.22x) | 16.0 (11.72x) |
| style (ms) | 6.9 (1.08x) | 6.4 (1.01x) | **6.3** |
| layout (ms) | 31.6 (1.01x) | 31.5 (1.01x) | **31.2** |
| JS heap | **1368.6 KB** | 2995.4 KB (2.19x) | 3128.1 KB (2.29x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 27.3 KB (3.41x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 71.0 KB (3.50x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | 0.9 KB (1.92x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.6 KB (1.88x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **2.0** | 2.7 (1.40x) | 4.7 (2.42x) |
| style (ms) | 0.4 (2.19x) | 0.2 (1.01x) | **0.2** |
| layout (ms) | 3.2 (1.15x) | **2.8** | 2.9 (1.04x) |
| JS heap | 1778.4 KB (1.14x) | **1561.9 KB** | 1591.3 KB (1.02x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. Every framework waits the same one task after the click before the result is checked.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 36.1 (1.04x) | **34.9** | 36.9 (1.06x) |
| replace 1,000 rows | 36.5 (1.07x) | **34.3** | 35.2 (1.03x) |
| update every 10th row | 4.9 (1.46x) | 3.4 (1.03x) | **3.3** |
| select row | 1.9 (4.88x) | **0.4** | 1.4 (3.38x) |
| swap rows | 3.9 (1.56x) | **2.5** | 3.2 (1.26x) |
| remove row | 5.6 (2.33x) | **2.4** | 3.0 (1.23x) |
| create 10,000 rows | 276 (1.02x) | **270** | 298 (1.11x) |
| append 1,000 rows | 34.5 (1.05x) | **33.0** | 33.4 (1.01x) |
| clear 1,000 rows | 4.3 (1.27x) | **3.4** | 4.2 (1.24x) |
