---
description: The links of a site's header, folded into a menu button on a narrow screen.
---

<Demo name="site-nav/basic" />

## Current page

`current` is the path of the page on screen: its link is marked as the page, and a link to a section holding it is marked as current. Here the page is `/guides/tutorial`, so Guides is marked and Home is not, as only an exact match marks the home page.

<Demo name="site-nav/section" />

## Narrow screens

`label` names the navigation for screen readers, and `menuLabel` the button shown on a narrow screen, which opens the links and closes on Escape, a click on a link or a click outside. The fold depends on the screen width, so it cannot be shown in a demo on a wide frame: narrow the window to see it.
