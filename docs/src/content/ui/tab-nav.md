---
description: A tab bar whose tabs are links to pages of their own.
---

<Demo name="tab-nav/basic" />

Each tab is a plain link, so a reload, a new tab or a shared URL opens it. `current` is the `href` of the page on screen, and its link is marked as current. Following a tab keeps the page scrolled where it was, so the bar does not need `data-keep-scroll`, and going back restores the saved position. A link to a `#section` scrolls to the section instead, in a bar of page tabs too. For tabs that switch content on the same page, use [Tabs](/ui/tabs).

## A long bar

When the bar scrolls, the current tab is centred in it, without moving the page.

<Demo name="tab-nav/scroll" />

## Tabs of a query param

When the tabs are the values of one query param, give `tabs` and `param` instead of `links`. Each tab links to the current page with the param set and every other param kept, and the one the address names is current. No `current` is needed, and `base`, `trailingSlash` and the locale prefix are added as for any link.

```kay
TabNav(tabs={[{ value: 'findings', label: 'Findings' }, { value: 'hosts', label: 'Hosts' }]} param="tab" label="Host")
```

The first tab is current while the param is left out. When the page shows another by default, pass it as `paramDefault`: its tab is current without the param and its link leaves the param out. `keep` is not needed here, as every other param is kept. These links follow the address of the request, so the page must be rendered per request, not once at build time.

## Sub-pages

A link is current on its own page only. Give it `prefix: true` to be current on every page under its path as well, or `also` with the paths whose pages should mark it. This needs the page's URL as `current`, and the exact page still wins.

```kay
TabNav(links={[{ href: '/traffic', label: 'Traffic', prefix: true }, { href: '/logs', label: 'Logs', also: ['/logs/archive'] }]} current={url} label="Site")
```

## Params the tabs share

Tabs over one set of filters, such as a period or a site, keep them from tab to tab. Pass the page's URL, read in the server fence as `const url = ctx.url`, as `current` and name the params in `keep`. Each link carries them, unless it sets that param itself. With a URL, the current tab is the one whose path matches, along with any param its link sets.

```kay
TabNav(links={TABS} current={url} keep={['period', 'site']} label="Traffic")
```
