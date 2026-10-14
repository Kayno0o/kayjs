---
title: components/
order: 13
description: The components the pages share, by convention.
path: src/components/
---

`src/components/` holds the components shared by pages and layouts. The folder is a convention: kay routes nothing in it, and a component is any `.kay` file, imported by its path.

<FileTree tree="
src/components/
  card.kay
  site-header.kay
" />

```kay
---
import Card from '../components/card.kay'
---
Card(title="Welcome")
```

A component with an `on*` handler, a `bind:`, a `ref`, or a script using a value from `kay` is an [island](/essentials/islands): rendered on the server, then hydrated in the browser. Every other one ships nothing.

<ReadMore href="/essentials/components">Components, their fences, props, slots and signals.</ReadMore>
