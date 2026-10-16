---
title: Introduction
order: 1
description: kay is a Bun web framework where a page is plain HTML and only the interactive parts ship JavaScript.
---

kay is a web framework for Bun. Pages render to plain HTML on the server, and only the parts that react to the visitor ship JavaScript. Everything is typed, templates included, so `kay check` catches a mistake at its line before it reaches the browser.

A `.kay` file is one component: TypeScript in fences, then an indented template. An [Elysia](https://elysiajs.com) plugin serves the pages.

## A first look

`src/routes/index.kay` is the home page. The `--- server` fence runs on the server for each request, and what it declares is available in the template:

```kay
--- server
const name = ctx.url.searchParams.get('name') ?? 'world'
---
h1 Hello {name}
p Welcome to #[a(href="/about") kay].
```

A component that reacts to the user is an island. This one has an `onClick` and a signal, so kay renders it on the server and hydrates it in the browser:

```kay
---
const count = signal(0)
---
button(onClick={() => count.set(c => c + 1)}) Clicked {count()} times
```

Saved as `src/components/counter.kay`, a page uses it like any component. The page around it stays plain HTML.

```kay
---
import Counter from '../components/counter.kay'
---
h1 Counter
Counter
```

## Key ideas

- HTML first: a page with no interactive component ships no JavaScript bundle, only one line of script keeping Back right.
- Islands: a component with an event handler, a `bind:` or a signal hydrates by itself, and only it.
- Typed actions: forms post to server actions checked against a schema, with or without JavaScript.
- `kay check` type-checks everything, templates included, and reports errors at the `.kay` line and column.

## Where to go next

- [Choosing kay](/getting-started/choosing-kay) compares kay with Astro, SvelteKit, Next and HTMX, and says what it costs.
- [Installation](/getting-started/installation) creates a project.
- [Project structure](/getting-started/project-structure) shows where things live.
- [Templates](/essentials/templates) and [Components](/essentials/components) teach the syntax.
- [How a request runs](/essentials/how-a-request-runs) shows what runs on the server and what in the browser.
- [The tutorial](/guides/tutorial) builds a small app step by step.
- [Migrating from Astro](/migrating/migrating-from-astro) moves an Astro site over with one command.
- [Migrating from SvelteKit](/migrating/migrating-from-sveltekit), [from Next.js](/migrating/migrating-from-nextjs) and [from Laravel](/migrating/migrating-from-laravel) map what you know to kay, concept by concept.

<ReadMore href="/llms">The full reference documents every topic, written for people and coding agents alike.</ReadMore>
