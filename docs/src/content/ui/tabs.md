---
description: Tabs that switch between panels on the same page, with keyboard navigation.
---

<Demo name="tabs/basic" />

`tabs` lists the `value` and `label` of each tab, and an `icon` drawn before it or `disabled` to keep it from being shown, the arrow keys going past it, and `@panel(tab)` draws the panel for a value. The arrow keys, Home and End move between tabs. For tabs that are pages of their own, use [TabNav](/ui/tab-nav).

## Panels keep their state

Every panel is drawn once and hidden while its tab is not shown, so what it holds survives a switch: a half-typed draft is still there when you come back.

<Demo name="tabs/state" />

## Following the selected tab

`value` is the tab shown, and tabs whose parent passes another follow it. `onChange` reports each switch, so the rest of the page can follow it.

<Demo name="tabs/shared" />

A `value` that names no enabled tab, such as an unknown one read from a URL or a disabled tab, shows the first enabled tab, so a tab is always in the tab order. `onChange` hears nothing for that fallback.

## Tabs of a query param

Give `param` instead of `value` to hold the shown tab in a query param of the page, with no island of your own: the server draws that tab from the first paint, and a pick rewrites the address without a navigation, as every panel is already drawn. The other params are kept and the current history entry is replaced, so Back leaves the page rather than the last tab.

```kay
Tabs(tabs={[{ value: 'details', label: 'Details' }, { value: 'reviews', label: 'Reviews' }]} param="tab" paramDefault="details" label="Product")
  @panel(tab)
    ProductPanel(tab={tab})
```

`paramDefault` is the tab shown while the param is left out, and picking it leaves the param out. Without it the first enabled tab is shown, and picking it sets the param like any other. `onChange` still runs on each pick. The page must be rendered per request, not once at build time.
