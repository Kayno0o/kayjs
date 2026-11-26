---
title: Migrating from v1
description: Concrete differences and migration checklist for moving from Kay v1 (.kay files, Elysia) to Kay v2 (standard TSX, native Bun.serve, modular KayPlugin ecosystem).
section: production
order: 2
---

Kay v2 replaces v1's `.kay` single-file format and Elysia runtime with standard `.tsx`, native `Bun.serve()`, and a modular `KayPlugin` architecture.

## Side-by-side mapping

| Concept | Kay v1 | Kay v2 |
| :--- | :--- | :--- |
| File format | `.kay` (fences + pug template) | Standard `.tsx` (`jsxImportSource: "@kayjs/kay"`) |
| Package | `kay` | `@kayjs/kay`, `@kayjs/kay/server`, `@kayjs/kay/config`, `@kayjs/kay/test` |
| Signals | `const n = signal(0); n()` / `n++` | `const n = signal(0); n.value` / `n.value++` |
| Props | `const { x } = props<{ x: number }>()` | Standard TS params `({ x }: { x: number })` (reactive) |
| Loops | `for item of items key={item.id}` | `{items.map(item => <li key={item.id}>...</li>)}` |
| Conditionals | `if cond` / `else` | `{cond ? <A /> : <B />}` / `{cond && <A />}` |
| Server data | `--- server` fence | `export default async function Page()` or `export function load(ctx)` |
| Server actions | `_actions.kay` / inline actions | Top-level named `export const fn = action(schema, handler)` in `src/actions/*.ts` |
| Server runtime | Elysia | Native `Bun.serve()` (`ctx.locals`, `ctx.cookies`, `ctx.json()`, `ctx.deny()`) |
| Prerender | `export const page = { prerender: posts }` | `export const prerender = true; export const paths = () => posts.paths('/posts')` |
| Head tags | `head` block | `<Head><title>...</title></Head>` |
| UI library | `@kayjs/ui` v1 (JS recipes) | `@kayjs/ui` v2 (headless primitives + pure CSS `@layer kui` grammars) |
| Config extensions | `extensions: [...]` + built-in flags | Unified `plugins: [...]` (`KayPlugin`) |

## What changes in practice

### 1. Explicit imports and strict JSX
- Kay v2 has no auto-imports. Import `signal`, `computed`, `Head`, `Suspense`, and components explicitly.
- Pass HTML strings directly to `innerHTML={html}` (never `{ __html }` or `dangerouslySetInnerHTML`).
- Use camelCase DOM events (`onClick`, `onDblClick`, `onKeyDown`), callback refs (`ref={el => ...}`), and kebab-case SVG attributes (`stroke-width`).
- Never pass functions or signals from a server component into an island prop; `kay check` flags them.

### 2. Routes, actions, and middleware
- Move server mutations out of `_actions.kay` into top-level named exports in `src/actions/*.ts` using `action(schema, handler)` from `@kayjs/kay/server`.
- Replace Elysia `.derive()` / lifecycle hooks with `_middleware.ts` files (setting `ctx.locals.*`) or `KayPlugin.server(api)`.
- Behind nginx, Caddy, or Cloudflare, set `trustProxy: true` (or the hop count) in `kay.config.ts` so CSRF origin checks, `ctx.ip`, and HSTS read the right forwarded headers.
- Client code can only read `process.env.PUBLIC_*` (inlined at build time). Use `nodeEnv()` from `@kayjs/kay/server` when checking `NODE_ENV` inside `--compile` binaries.

### 3. Plugins (`@kayjs/ui`, `@kayjs/auth`, `@kayjs/content`, `@kayjs/mcp`)
- **`@kayjs/ui`**: Register `ui({ grammar: 'orbit' })` from `@kayjs/ui/plugin`. Styles live in pure CSS `@layer kui` instead of JS recipe engines.
- **`@kayjs/auth`**: `requireEmailVerification` defaults to `true`, `site` is required off localhost, and `secret` (`>= 32` bytes) is required in production.
- **`@kayjs/content`**: Call `await entry.render()` once in `load()` so index routes, sitemaps, and RSS feeds never pay to load Shiki or render Markdown bodies.
- **`@kayjs/mcp`**: Mount `mcp({ token, tools })` in `kay.config.ts` directly on your existing `action()` exports, and check tool token weight with `kay mcp-footprint`.

## Changes during the v2 beta

- **2.0.0-beta.4**: kay is imported as `@kayjs/kay` only, and a bare `kay` import now fails the compile. Run `bunx @kayjs/kay@beta upgrade` in the app: it depends on `"@kayjs/kay"`, sets `"jsxImportSource": "@kayjs/kay"` and rewrites every import, then prints any it could not move. `defineConfig`, `definePlugin` and the plugin types move from `@kayjs/kay/server` to `@kayjs/kay/config`. `@kayjs/kay/server` no longer exports kay's internals (`loadConfig`, `DEFAULT_CSP`, `withCspHashes`, compression and app-context helpers). A plugin HTML route gets the app's CSP with its `<style>` blocks hashed, so it no longer builds its own. What `createAuth()`, `createMailer()` and `createRooms()` return is the plugin itself: register `auth`, `mail` and `rooms` instead of `auth.plugin`, `mail.plugin()` and `rooms.plugin({...})`, whose options move into `createRooms({ path, member, ... })`. `mailer()` is now `createMailer()` (taking the preview options), `mailPlugin()` is gone, and `contentPlugin()` is `content()`. `provide` and `inject` take a key from `serviceKey<T>(name)` instead of a string, and `KayPlugin.dispose` is gone: release state in `api.onShutdown()`. `kay upgrade` does the renames and registrations, and names each `plugin(...)` call whose options you move by hand. A server action called from a route, `load()`, middleware or another action now runs in that request, so `ServerPluginAPI.invokeAction` is gone: call the action itself. `island()` is gone: write `export const hydrate = 'visible'` in the component's file, or `$hydrate` where it renders. A file under `src/routes/` exporting no page, method handler or action now fails the build: prefix a helper or its folder with `_`. `_layout`, `_middleware`, `_error` and `_404` need a default export. `<Head>` and `<Suspense>` in an island fail the compile, and an island reading a context provided outside it throws during SSR: pass the value as a prop.

<Callout title="Verify after porting" tone="tip">
Run `kay check` and `kay build --analyze` after migrating a route or app. `kay check` catches server-only imports in islands, non-serializable island props, missing `paths()`, and invalid JSX before runtime.
</Callout>
