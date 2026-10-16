---
title: tsconfig.json
order: 23
description: The TypeScript settings, extending kay's.
path: tsconfig.json
---

`tsconfig.json` extends kay's, which merges the generated [`.kay/types`](/structure/dot-kay) tree with the sources and is as strict as kay itself.

```json
{ "extends": "kay/tsconfig.json" }
```

It includes `src`, `tests`, the `*.config.ts` files beside it, such as `kay.config.ts`, and `.kay/types`.

A project adds its own `compilerOptions` beside `extends`. An `include` of its own replaces kay's, so it lists `.kay/types` again.

`kay check` types the project through it, `.kay` files included, and `-p` names another.

<ReadMore href="/llms/project">The project's setup in the full reference.</ReadMore>
