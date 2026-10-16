---
title: (group)/
order: 9
description: A folder in parentheses, grouping pages under a layout or a guard without changing their URL.
path: src/routes/(group)/
---

A folder in parentheses adds nothing to the URL, so `(marketing)/pricing.kay` is `/pricing`. It only brings its own [`_layout.kay`](/structure/layout) and [`_guard.ts`](/structure/guard) to the pages inside it.

<FileTree tree="
src/routes/
  (marketing)/
    _layout.kay  the marketing header
    pricing.kay  /pricing
  (app)/
    _guard.ts  asks for a session
    dashboard.kay  /dashboard
" />

Two pages serving one path stop the server, a group's included, such as `about.kay` beside `(site)/about.kay`.

<ReadMore href="/essentials/routing#layouts">Layouts and groups in the routing guide.</ReadMore>
