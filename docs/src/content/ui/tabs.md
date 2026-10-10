---
description: Tabs that switch between panels on the same page, with keyboard navigation.
---

<Demo name="tabs/basic" />

`tabs` lists the `value` and `label` of each tab and `@panel(tab)` draws the panel for a value. The arrow keys, Home and End move between tabs. For tabs that are pages of their own, use [TabNav](/ui/tab-nav).

## Panels keep their state

Every panel is drawn once and hidden while its tab is not shown, so what it holds survives a switch: a half-typed draft is still there when you come back.

<Demo name="tabs/state" />

## Following the selected tab

`value` is the tab shown, and tabs whose parent passes another follow it. `onChange` reports each switch, so the rest of the page can follow it.

<Demo name="tabs/shared" />
