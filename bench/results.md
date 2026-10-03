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
| renders/s | 1899 (2.01x) | 1749 (2.18x) | **3815** |
| mean (ms) | 0.5 (2.01x) | 0.6 (2.18x) | **0.3** |
| p50 (ms) | 0.5 (1.91x) | 0.5 (2.13x) | **0.2** |
| p99 (ms) | 1.2 (1.68x) | 1.6 (2.11x) | **0.7** |

## Products page in Chromium

Medians of fresh loads with an empty cache: Chromium's main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 26.5 KB (3.31x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 69.4 KB (3.42x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | **8.4 KB** | 21.6 KB (2.56x) | 15.6 KB (1.86x) |
| HTML (raw) | **93.4 KB** | 171.8 KB (1.84x) | 138.6 KB (1.48x) |
| script (ms) | **1.4** | 12.5 (8.85x) | 15.9 (11.26x) |
| style (ms) | 6.8 (1.09x) | 6.5 (1.04x) | **6.2** |
| layout (ms) | 31.9 (1.03x) | 32.0 (1.03x) | **31.1** |
| JS heap | **1369.0 KB** | 2974.1 KB (2.17x) | 3130.8 KB (2.29x) |

## Table page in Chromium

|  | kay | solid | svelte |
| --- | --- | --- | --- |
| JS shipped (gzip) | 27.5 KB (3.43x) | **8.0 KB** | 21.8 KB (2.73x) |
| JS shipped (raw) | 71.5 KB (3.52x) | **20.3 KB** | 57.6 KB (2.84x) |
| JS files | 4 | 1 | 1 |
| HTML (gzip) | 0.9 KB (1.91x) | 0.7 KB (1.58x) | **0.4 KB** |
| HTML (raw) | 1.6 KB (1.88x) | 1.3 KB (1.49x) | **0.9 KB** |
| script (ms) | **2.0** | 2.8 (1.40x) | 4.8 (2.39x) |
| style (ms) | 0.4 (2.10x) | **0.2** | 0.2 (1.01x) |
| layout (ms) | 3.2 (1.16x) | **2.8** | 2.9 (1.04x) |
| JS heap | 1782.1 KB (1.16x) | **1539.3 KB** | 1588.3 KB (1.03x) |

## Table operations

The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. Every framework waits the same one task after the click before the result is checked.

| operation | kay | solid | svelte |
| --- | --- | --- | --- |
| create 1,000 rows | 38.7 (1.11x) | **34.8** | 36.3 (1.04x) |
| replace 1,000 rows | 36.4 (1.21x) | 33.7 (1.12x) | **30.0** |
| update every 10th row | 5.2 (1.55x) | **3.3** | 4.3 (1.30x) |
| select row | **0.4** | 0.5 (1.13x) | 1.3 (3.25x) |
| swap rows | 3.9 (1.54x) | **2.5** | 2.5 (1.02x) |
| remove row | 5.7 (2.28x) | **2.5** | 5.6 (2.24x) |
| create 10,000 rows | 283 (1.07x) | 277 (1.04x) | **266** |
| append 1,000 rows | 34.4 (1.06x) | **32.4** | 32.9 (1.02x) |
| clear 1,000 rows | 4.4 (1.27x) | **3.5** | 4.1 (1.19x) |
