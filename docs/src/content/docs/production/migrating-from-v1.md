---
title: Migrating from v1
description: Key differences between Kay v1 (.kay files, Elysia) and Kay v2 (standard TSX, native Bun.serve, modular KayPlugin ecosystem).
section: production
order: 2
---

Kay v2 replaces v1's custom `.kay` template language and Elysia runtime with standard `.tsx`, native `Bun.serve()`, and a strict `KayPlugin` architecture.

## Side-by-side mapping

| Concept | Kay v1 | Kay v2 |
| :--- | :--- | :--- |
| File format | `.kay` (fences + pug template) | Standard `.tsx` (`jsxImportSource: "kay"`) |
| Signals | `const n = signal(0); n()` / `n++` | `const n = signal(0); n.value` / `n.value++` |
| Props | `const { x } = props<{ x: number }>()` | Standard TS params `({ x }: { x: number })` (reactive!) |
| Loops | `for item of items key={item.id}` | `{items.map(item => <li key={item.id}>...</li>)}` |
| Conditionals | `if cond` / `else` | `{cond ? <A /> : <B />}` / `{cond && <A />}` |
| Server data | `--- server` fence | `export default async function Page()` or `export function load(ctx)` |
| Server runtime | Elysia | Native `Bun.serve()` |
| Prerender | `export const page = { prerender: posts }` | `export const prerender = true; export const paths = () => posts.paths('/posts')` |
| Head tags | `head` block | `<Head><title>...</title></Head>` |
| UI library | `@kayjs/ui` v1 (JS recipes) | `@kayjs/ui` v2 (headless primitives + pure CSS `@layer kui` grammars) |
| Config extensions | `extensions: [...]` + built-in flags | Unified `plugins: [...]` (`KayPlugin`) |

<Callout title="Why standard TSX?" tone="info">
Moving to standard `.tsx` eliminated ~40,000 lines of custom parser, shadow-TSX, LSP, formatter, and editor plugins — while giving you native TypeScript tooling, 18.8 ms clean builds, and ~3–4× smaller client bundles.
</Callout>
