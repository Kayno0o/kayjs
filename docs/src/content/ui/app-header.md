---
description: The bar across the top of an app, with its brand, main links and an area at the far end.
---

<Demo name="app-header/basic" />

`AppHeader` takes the props of [SiteNav](/ui/site-nav), `links`, `current` and `label`, and writes its brand and its end area as blocks. It draws a `header` holding the brand, the navigation and the end area, in one row. The brand sits at the start, the links follow it, and the end area, such as a user menu or a theme toggle, is held at the far end.

## Brand and end area

`@brand` holds the site's name or logo, usually a link home, and `@end` what the app puts at the far end. A block left out draws nothing, so a header with no end area is the brand and the links.

## Icons

Each link takes an `icon`, as in SiteNav. Write the links `as const` so an icon's name stays a slot name.

## Staying at the top

The header is sticky: it stays at the top of the page while the page scrolls. Set `sticky={false}` to let it scroll away with the page. The demo above sets it so it does not stick to this page.

A sticky header covers what an anchor link scrolls to. Give the page `scroll-padding-top` of the header's height, as in `html { scroll-padding-top: 4rem }`.

## Narrow screens

Below the `lg` breakpoint the links fold behind SiteNav's menu button, which opens them as a popover the browser closes on Escape or a click outside. The button follows the brand, in the tab order too, and the end area keeps the far end. A long brand or end area wraps instead of widening the bar. `label` names the navigation and `menuLabel` the button.

## Colors

It is painted with the `--color-kui-*` tokens: the canvas for its ground and the surface line under it. A skin changes it with no CSS of its own.
