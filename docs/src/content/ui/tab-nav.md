---
description: A tab bar whose tabs are links to pages of their own.
---

<Demo name="tab-nav/basic" />

Each tab is a plain link, so a reload, a new tab or a shared URL opens it. `current` is the `href` of the page on screen, and its link is marked as current. Following a tab keeps the page scrolled where it was, so the bar does not need `data-keep-scroll`, and going back restores the saved position. A link to a `#section` scrolls to the section instead, in a bar of page tabs too. For tabs that switch content on the same page, use [Tabs](/ui/tabs).

## A long bar

When the bar scrolls, the current tab is centred in it, without moving the page.

<Demo name="tab-nav/scroll" />

## Params the tabs share

Tabs over one set of filters, such as a period or a site, keep them from tab to tab. Pass the page's URL, read in the server fence as `const url = ctx.url`, as `current` and name the params in `keep`. Each link carries them, unless it sets that param itself. With a URL, the current tab is the one whose path matches, along with any param its link sets.

```kay
TabNav(links={TABS} current={url} keep={['period', 'site']} label="Traffic")
```
