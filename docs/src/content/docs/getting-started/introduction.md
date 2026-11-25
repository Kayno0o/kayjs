---
title: Introduction
description: Why Kay v2 exists — standard TypeScript & JSX, zero-directive automatic islands, fine-grained .value signals, and single-binary Bun deploys.
section: getting-started
order: 1
---

Kay v2 is a Bun-native web framework. You write standard TypeScript and JSX. Static components ship zero JavaScript, and interactive components become islands automatically.

## What makes Kay v2 different

- **Zero directives**: No `'use client'`, no `'use server'`, no `client:load`. `oxc-parser` analyzes your `.tsx` files at build time and splits static SSR trees from interactive `<kay-island>` roots.
- **Plain `.value` signals**: A doubly-linked-list reactivity kernel (`signal`, `computed`, `effect`, `batch`, `selector`, `store`) with no compiler assignment magic.
- **Flat-string SSR**: Static JSX compiles directly to flat string concatenation (`7,017 renders/s` on the products benchmark).
- **Unified server actions**: Write one `action(schema, handler)` with any Standard Schema validator (Zod, Valibot, ArkType, TypeBox). It works as a zero-JS `<form action={fn} method="post">` and as a typed RPC call from islands.
- **Single-pass build & `--compile`**: One `Bun.build()` pass compiles your app in `18.8 ms` clean. `kay build --compile` packs routes, plugins, and `public/` assets into a single executable with a `35.4 ms` cold start.
- **Small core, modular plugins**: Everything optional (`@kayjs/ui`, `@kayjs/auth`, `@kayjs/content`, `@kayjs/live`, `@kayjs/mcp`, `@kayjs/images`, `@kayjs/seo`, `@kayjs/i18n`, `@kayjs/mail`, `@kayjs/icons`, `@kayjs/tailwind`, `@kayjs/spa`) plugs in through `KayPlugin`.

<Callout title="Coding-agent reference" tone="tip">
The entire Kay v2 API fits on one dense page at [`/llms.txt`](/llms.txt).
</Callout>
