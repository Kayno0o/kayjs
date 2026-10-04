# Where kay's bytes and time go

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 6d50f45, solid-js 2.0.0-rc.13, @solidjs/web 2.0.0-rc.13
- run on 2026-10-04

How much of what kay costs is Solid's, to weigh replacing its runtime and compiler. Solid is solid-js, @solidjs/signals, @solidjs/web and seroval; kay is kay's runtime and the entry it generates; app is the bench app's components as Solid's compiler wrote them and its shared data. Reproduce with `bun run bench:origins`; the cross-framework numbers are in results.md.

## JS shipped

The client kay builds for production, every byte attributed through its source maps. Raw bytes add up to the files' size; "gzip saved" is how much smaller the gzipped files get without that origin's bytes, so it does not add up to the total.

|  | products raw | products gzip saved | table raw | table gzip saved |
| --- | --- | --- | --- | --- |
| Solid | 66.7 KB (89%) | 24.8 KB (87%) | 66.7 KB (87%) | 24.8 KB (84%) |
| kay | 2.2 KB (3%) | 1.0 KB (4%) | 2.2 KB (3%) | 1.0 KB (4%) |
| app | 0.3 KB (0%) | 0.2 KB (1%) | 2.3 KB (3%) | 1.2 KB (4%) |
| devalue | 4.6 KB (6%) | 1.7 KB (6%) | 4.6 KB (6%) | 1.7 KB (6%) |
| bundler | 1.1 KB (1%) | 0.7 KB (2%) | 1.1 KB (1%) | 0.7 KB (2%) |
| **total** | 74.8 KB | 28.6 KB gzip | 76.9 KB | 29.6 KB gzip |

## Server rendering

Microseconds per render of the products page, from Bun's CPU profiler over warm in-process renders. A native function, such as a string method, counts for the JavaScript that called it.

|  | µs per render |
| --- | --- |
| Solid | 267 (61%) |
| kay | 72 (16%) |
| app | 81 (18%) |
| elysia | 14 (3%) |
| engine | 5 (1%) |
| devalue | 2 (0%) |
| **total** | 441 |

## Page loads in Chromium

Main-thread milliseconds per fresh load up to network idle, from Chromium's CPU profiler sampling every 50 µs, means of 10 loads. A DOM call counts for the JavaScript that made it, so the time a replacement would still spend creating nodes is in Solid's share. engine is Chromium's own work outside any script: parsing, style, layout. inline scripts are the page's inline scripts.

|  | products | table |
| --- | --- | --- |
| Solid | 2.2 (4%) | 2.8 (19%) |
| kay | 0.6 (1%) | 0.5 (4%) |
| app | 0.2 (0%) | 1.1 (7%) |
| engine | 50.7 (93%) | 9.6 (65%) |
| bundler | 0.3 (1%) | 0.3 (2%) |
| devalue | 0.4 (1%) | 0.2 (1%) |
| inline scripts | 0.1 (0%) | 0.1 (0%) |
| GC | 0.0 (0%) | 0.1 (0%) |
| **total** | 54.6 | 14.7 |

## Table operations in Chromium

The operations of results.md, 10 profiled samples each, means in ms. "measured" is the click-to-DOM time as results.md times it, "profiled" the time the profiler saw over the same window. style and layout is the work the timing forces with `offsetHeight` once the DOM holds the result: what Chromium spends laying out the rows, whoever made them.

| operation | measured (ms) | profiled (ms) | Solid | kay | app | GC | engine | style and layout | other | Solid share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| create 1,000 rows | 37.1 | 42.2 | 8.3 | 0.6 | 1.9 | 4.8 | 4.5 | 22.1 | 0.0 | **20%** |
| replace 1,000 rows | 30.7 | 35.2 | 9.7 | 0.4 | 1.2 | 0.1 | 4.5 | 19.4 | 0.0 | **28%** |
| update every 10th row | 4.0 | 4.9 | 1.3 | 0.0 | 0.0 | 0.0 | 0.8 | 2.8 | 0.0 | **26%** |
| select row | 0.3 | 0.7 | 0.1 | 0.0 | 0.0 | 0.0 | 0.4 | 0.2 | 0.0 | **20%** |
| swap rows | 3.0 | 3.9 | 1.0 | 0.0 | 0.0 | 0.0 | 0.7 | 2.1 | 0.0 | **26%** |
| remove row | 3.0 | 4.7 | 1.1 | 0.0 | 0.0 | 0.0 | 1.6 | 2.0 | 0.0 | **23%** |
| create 10,000 rows | 261 | 296 | 43.3 | 2.4 | 9.5 | 15.5 | 34.7 | 191 | 0.0 | **15%** |
| append 1,000 rows | 28.3 | 32.6 | 6.4 | 0.3 | 1.1 | 0.0 | 4.1 | 20.7 | 0.0 | **20%** |
| clear 1,000 rows | 3.8 | 4.5 | 3.6 | 0.1 | 0.0 | 0.0 | 0.6 | 0.2 | 0.0 | **81%** |
