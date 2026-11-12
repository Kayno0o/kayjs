---
title: _loading.kay
order: 4.5
description: The page shown while a link to a slow page is being followed.
path: src/routes/_loading.kay
---

`_loading.kay` is what a click on a link shows while the page it follows is still on its way, so a slow page never feels like a dead click. Put it in a folder and it covers the pages of that folder and below; the nearest one wins, as `_404.kay` does.

```kay
p(role="status") Loading…
```

It shows only when the page has not answered after 200 ms (`client.loadingDelay` changes it, `'0s'` shows it at once), so a quick page never flashes it. It renders in place of the page, inside the page's own layouts, which stay where they are, and the page replaces it when it arrives. The address, the title, the scroll and the focus change only then, and `kay:navigate` fires once, for the page.

The server renders it from a request for the page's own address, with the page's guards and layouts and none of its loads, so it reads `ctx.params` and anything a layout loads, and a page a guard refuses shows nothing. Keep the file free of loads, as it is only worth showing when it is quick. Islands in it are drawn but not started.

It runs the guards and layout loads a second time for each slow visit, so keep layout loads cheap or cached. It is skipped when the page left holds a `persist` island its layouts do not carry, so that island is not lost.

It applies to a link, `navigate()` or Back and Forward to another path, not to a change of the query of the page the visitor is on, and not to a static export, which has no server to ask. A page that fails, or an error page, replaces it as it replaces any page.

<ReadMore href="/essentials/islands#page-navigation">How a link swaps the page in place.</ReadMore>
