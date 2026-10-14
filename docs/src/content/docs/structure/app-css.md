---
title: app.css
order: 17
description: The site's own stylesheet, imported by the root layout.
path: src/app.css
---

`src/app.css` is the stylesheet every page shares. The root [`_layout.kay`](/structure/layout) imports it, and a page links the stylesheets of its layouts, then its own:

```kay
---
import '../app.css'
---
slot
```

With Tailwind, registered in [`kay.config.ts`](/structure/kay-config), it needs only its import. kay collects the classes written with the `.class` shorthand into [`.kay/classes.txt`](/structure/dot-kay) and hands them to Tailwind:

```css
@import 'tailwindcss';
```

`@import`, nesting and relative `url()` assets work in it, as in any stylesheet a component imports. kayjs-ui's theme is imported right after Tailwind, and an `@theme` block below overrides its tokens.

<ReadMore href="/essentials/styling-and-assets#tailwind">Tailwind and component styles in the styling guide.</ReadMore>
