---
title: Choosing kay
order: 2
description: Who kay is for, how it differs from Astro, SvelteKit, Next and HTMX, and what choosing it costs.
---

kay is for sites and apps on Bun whose pages are mostly content and forms, with some parts that react to the user. Think of documentation, a shop, or a dashboard behind a sign-in.

Every page renders to HTML on the server, and only the components that handle an event ship JavaScript. A page stays light however much it shows.

Forms, sessions, guards, jobs, uploads, translations and search come with kay. You add no plugin for them.

## Next to its neighbours

**Astro** is the closest. It is HTML first, with islands. An Astro island is a React, Vue, Svelte or Solid component, hydrated once you add a `client:` directive.

A kay island is a `.kay` component like any other. It hydrates because it has an event handler, a `bind:`, a `ref` or a signal. It needs no directive and no second framework.

Astro starts from static pages and renders on demand through an adapter. kay serves through an Elysia plugin, with server actions, sessions and guards built in. [Migrating from Astro](/migrating/from-astro) moves a site over with one command.

**SvelteKit** hydrates the whole page. The HTML carries the page's data again as JSON, and the components of the whole page run once more in the browser.

kay hydrates its islands only and sends no data for the rest. Take the same products page built with plain Svelte 5 and with Solid. kay's [benchmark](https://github.com/Kayno0o/kayjs/blob/main/bench/results.md) sends half to a third of their HTML gzipped, and a fortieth of their script time on load. It does so for 10 KB of JavaScript gzipped against Solid's 8.

[Migrating from SvelteKit](/migrating/from-sveltekit) maps its concepts to kay's.

**Next** splits a page into server components, which ship no JavaScript, and client components marked `'use client'`. It sends a payload describing the server part beside the HTML.

kay draws the same line with no marker and no payload. A component with no interactivity stays HTML. Next runs on Node and on edge runtimes, and has the React ecosystem behind it. [Migrating from Next.js](/migrating/from-nextjs) maps its concepts to kay's.

**HTMX** works on Elysia or any server. It swaps HTML fragments the server sends, driven by attributes, with no build step.

kay has [page swaps](/essentials/islands#page-navigation) of its own. It adds what HTMX leaves to you: components with typed props, and state in the browser where a page needs it. `kay check` types every template and checks each link against your routes.

## What it costs

- **Bun only**, 1.4.3 or later. The server needs Bun, not Node, Deno or an edge runtime. A site built with `kay build --static` is plain files any host serves.
- **Its own registry.** kay and its libraries are on kay's Forgejo registry, not on npm. Point Bun at it once, as [Installation](/getting-started/installation) shows. A search on npm does not find them.
- **A young ecosystem.** Few integrations exist beyond kay's libraries: [kayjs-ui](/libraries/kayjs-ui), [kayjs-auth](/libraries/kayjs-auth), [kayjs-mail](/libraries/kayjs-mail), [kayjs-cms](/libraries/kayjs-cms) and [kayjs-ai](/libraries/kayjs-ai). Answers are in these docs, not across the web. Coding agents learn kay from [llms.txt](/llms.txt), not from their training.
- **No JSX components to reuse.** React, Vue and Svelte components do not run in `.kay`, and their component libraries have no kay version. A plain browser library, such as a map or a chart, runs inside an island.
- **Its own file format.** Editors read `.kay` through `kay lsp`, in VS Code or any LSP editor. Tools that only know HTML, JSX or Svelte files do not.
- **It moves fast.** A minor version can carry a breaking change. [Upgrading](/guides/upgrading) lists each with what to change. A major is kept for a rewrite.

## When to pick something else

- Your server has to run on Node or on an edge runtime: Astro, SvelteKit or Next.
- Your components are already written in React, Vue or Svelte: Astro keeps them as islands, or stay with their framework.
- Most of your app runs in the browser, page after page of client state: SvelteKit or Next, which hydrate everything anyway.
- Your server is written in another language and only needs some interactivity: HTMX.
