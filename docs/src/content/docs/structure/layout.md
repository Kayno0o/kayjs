---
title: _layout.kay
order: 2
description: The markup around every page in its folder and below.
path: src/routes/_layout.kay
---

A `_layout.kay` wraps every page in its folder and below, rendering the page at `slot`:

```kay
header
  a(href="/") Home
  a(href="/blog") Blog
main
  slot
```

Layouts nest, outermost first: `blog/_layout.kay` renders inside the root one. A [group folder](/structure/group) gives a set of pages a layout of their own without changing their URL. A page or a layout whose `page` setting holds `layouts: false` is wrapped by none of the layouts above it, so a section can drop the site's header.

The root layout is where the site's stylesheet, [`app.css`](/structure/app-css), is imported, and where its `head` block sets what every page shares:

```kay
---
import '../app.css'
---
head
  html(data-theme="light")
slot
```

<ReadMore href="/essentials/routing#layouts">Layouts and groups in the routing guide.</ReadMore>
