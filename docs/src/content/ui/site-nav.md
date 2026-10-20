---
description: The links of a site's header, folded into a menu button on a narrow screen.
---

<Demo name="site-nav/basic" />

For a whole header with the site's brand and an area at the far end, use [AppHeader](/ui/app-header).

## Current page

`current` is the path of the page on screen: its link is marked as the page, and a link to a section holding it is marked as current. Here the page is `/guides/tutorial`, so Guides is marked and Home is not, as only an exact match marks the home page.

<Demo name="site-nav/section" />

## Narrow screens

`label` names the navigation for screen readers, and `menuLabel` the button shown on a narrow screen. The fold depends on the screen width, so it cannot be shown in a demo on a wide frame: narrow the window to see it.

The button opens the links as a [popover](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API), so the browser closes them on Escape or a click outside and gives the focus back, and SiteNav ships no JavaScript. Following a link to another page closes them with the page swap. A link to a section of the same page leaves them open until the next click outside.

The popover needs Chrome and Edge 114, Firefox 125 or Safari 17. An older browser shows the links as a plain list and hides the button.

## Icons

A link takes an `icon`, a slot name or an imported icon, drawn before its label. It is decoration: the label still names the link. Write the links `as const` when they hold an icon, so its name stays a slot name.

## Id

`id` is the list's id, unique on the page. kay draws one when you give none.
