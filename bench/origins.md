# Where kay's bytes and time go

- AMD Ryzen 5 7600 6-Core Processor, 12 threads
- Bun 1.4.2, Chromium 151.0.7922.34 headless
- kay 5d698a0, solid-js 2.0.0-rc.13, @solidjs/web 2.0.0-rc.13
- run on 2026-10-04

How much of what kay costs is Solid's, to weigh replacing its runtime and compiler. Solid is solid-js, @solidjs/signals, @solidjs/web and seroval; kay is kay's runtime and the entry it generates; app is the bench app's components as Solid's compiler wrote them and its shared data. Reproduce with `bun run bench:origins`; the cross-framework numbers are in results.md.

## JS shipped

The client kay builds for production, every byte attributed through its source maps. Raw bytes add up to the files' size, the comments a source map build adds left out; "gzip saved" is how much smaller the gzipped files get without that origin's bytes, so it does not add up to the total.

|  | products raw | products gzip saved | table raw | table gzip saved |
| --- | --- | --- | --- | --- |
| Solid | 66.7 KB (89%) | 24.8 KB (87%) | 66.7 KB (87%) | 24.8 KB (84%) |
| kay | 2.2 KB (3%) | 1.0 KB (4%) | 2.2 KB (3%) | 1.0 KB (4%) |
| app | 0.3 KB (0%) | 0.2 KB (1%) | 2.3 KB (3%) | 1.2 KB (4%) |
| devalue | 4.6 KB (6%) | 1.7 KB (6%) | 4.6 KB (6%) | 1.7 KB (6%) |
| bundler | 0.9 KB (1%) | 0.5 KB (2%) | 0.9 KB (1%) | 0.5 KB (2%) |
| **total** | 74.6 KB | 28.5 KB gzip | 76.7 KB | 29.4 KB gzip |

## Server rendering

Microseconds per render of the products page, from Bun's CPU profiler over warm in-process renders. A native function, such as a string method, counts for the JavaScript that called it.

|  | µs per render |
| --- | --- |
| Solid | 283 (61%) |
| kay | 77 (16%) |
| app | 87 (19%) |
| elysia | 14 (3%) |
| engine | 5 (1%) |
| devalue | 2 (0%) |
| **total** | 468 |

## Page loads in Chromium

Main-thread milliseconds per fresh load up to network idle, from Chromium's CPU profiler sampling every 50 µs, means of 10 loads. A DOM call counts for the JavaScript that made it, so the time a replacement would still spend creating nodes is in Solid's share. engine is Chromium's own work outside any script: parsing, style, layout. inline scripts are the page's inline scripts.

|  | products | table |
| --- | --- | --- |
| Solid | 2.0 (4%) | 2.3 (18%) |
| kay | 0.6 (1%) | 0.4 (4%) |
| app | 0.2 (0%) | 1.0 (8%) |
| engine | 46.8 (93%) | 8.4 (66%) |
| bundler | 0.4 (1%) | 0.3 (3%) |
| devalue | 0.2 (0%) | 0.2 (1%) |
| GC | 0.1 (0%) | 0.1 (1%) |
| inline scripts | 0.1 (0%) | 0.1 (0%) |
| **total** | 50.5 | 12.8 |

## Table operations in Chromium

The operations of results.md, 10 profiled samples each after 2 warmups, means in ms where results.md gives medians. "measured" is the click-to-DOM time as results.md times it, a little longer with the profiler running; "profiled" the time the profiler saw over the same window. style and layout is the work the timing forces with `offsetHeight` once the DOM holds the result: what Chromium spends laying out the rows, whoever made them.

| operation | measured (ms) | profiled (ms) | Solid | kay | app | GC | engine | style and layout | other | Solid share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| create 1,000 rows | 34.1 | 38.5 | 7.8 | 0.5 | 2.0 | 5.0 | 3.9 | 19.3 | 0.0 | **20%** |
| replace 1,000 rows | 27.9 | 32.0 | 9.2 | 0.2 | 1.0 | 0.1 | 4.0 | 17.6 | 0.0 | **29%** |
| update every 10th row | 3.8 | 4.3 | 1.1 | 0.1 | 0.1 | 0.0 | 0.4 | 2.7 | 0.0 | **25%** |
| select row | 0.3 | 0.7 | 0.1 | 0.0 | 0.0 | 0.0 | 0.4 | 0.2 | 0.0 | **20%** |
| swap rows | 2.8 | 3.5 | 1.0 | 0.0 | 0.0 | 0.0 | 0.5 | 1.9 | 0.0 | **29%** |
| remove row | 2.7 | 3.2 | 1.0 | 0.0 | 0.1 | 0.0 | 0.4 | 1.8 | 0.0 | **30%** |
| create 10,000 rows | 262 | 298 | 44.8 | 2.3 | 9.0 | 15.8 | 36.0 | 191 | 0.0 | **15%** |
| append 1,000 rows | 27.0 | 31.1 | 6.0 | 0.2 | 1.1 | 0.0 | 4.0 | 19.7 | 0.0 | **19%** |
| clear 1,000 rows | 3.5 | 4.0 | 3.3 | 0.1 | 0.0 | 0.0 | 0.4 | 0.2 | 0.0 | **84%** |
