---
title: Introduction
description: Why Kay v2 exists — standard TypeScript & JSX, zero-directive automatic islands, fine-grained .value signals, and single-binary Bun deploys.
section: getting-started
order: 1
---

Kay v2 is a Bun-native web framework designed around one rule: **write standard TypeScript and JSX, ship zero JavaScript for everything static, and hydrate only the interactive islands automatically.**

## What makes Kay v2 different

- **Zero directives**: No `'use client'`, no `'use server'`, no `client:load` boilerplate. `oxc-parser` analyzes your `.tsx` files at build time and splits static SSR trees from interactive `<kay-island>` roots automatically.
- **Plain `.value` signals**: Built on a doubly-linked-list reactivity kernel (`signal`, `computed`, `effect`, `batch`, `selector`, `store`) with zero compiler assignment magic.
- **Flat-string SSR**: Static JSX compiles directly to flat string concatenation (`7,017 renders/s` on the products benchmark).
- **Unified Standard-Schema actions**: Write one `action(schema, handler)` with Zod, Valibot, ArkType, or any Standard Schema validator — it works both as a zero-JS progressive `<form action={fn} method="post">` and as a typed RPC call from islands.
- **Single-pass Bun build & `--compile`**: One `Bun.build()` pass produces minimal bundles (`18.8 ms` clean build) and compiles your whole app + plugins + `public/` assets into a single executable with `35.4 ms` cold start.
- **Tiny 6.9k LOC core**: Every optional capability (`@kayjs/ui`, `@kayjs/auth`, `@kayjs/content`, `@kayjs/live`, `@kayjs/images`, `@kayjs/seo`, `@kayjs/i18n`, `@kayjs/mail`, `@kayjs/icons`, `@kayjs/tailwind`, `@kayjs/spa`) plugs in cleanly through the public `KayPlugin` API.

<Callout title="AI & coding-agent friendly" tone="tip">
The entire Kay v2 API fits on one page at [`/llms.txt`](/llms.txt) — zero custom template syntax, standard TypeScript diagnostics, and clean compiler errors.
</Callout>
