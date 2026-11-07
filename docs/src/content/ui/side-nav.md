---
description: A vertical navigation with group headings, a collapsible rail and a panel on narrow screens.
---

<Demo name="side-nav/basic" />

`groups` are titled runs of links, `links` a run with no heading before them. A link is the same `NavLink` SiteNav takes: an `icon`, a `badge`, `disabled` (a text, not a link) and `children`, one level of links under it. `current` marks the page on screen the way [SiteNav](/ui/site-nav) does: the page itself, and a link to a section holding it.

## Collapsing

The toggle at the bottom narrows the nav to a rail of icons. A link with no icon shows its first letter, and the text stays there for screen readers, with a tooltip for everyone else. `collapsedKey` keeps the state in a cookie the server reads, so the rail is right from the first paint. Give `collapsed` to control it yourself, and listen to `onCollapsedChange(collapsed)`. `collapsible={false}` leaves the toggle out.

## Narrow screens

Below `lg` the nav gives way to a menu button opening the same lists in a [SidePanel](/ui/side-panel). Following a link closes it. `open` and `onOpenChange` control it, `menuLabel` names the button, and `panel={false}` keeps the nav in place at every width.

## Blocks

`@link(link)` draws the text of each link, `@heading(group)` the heading of each group, `@header` sits above the lists and `@footer` under them, pinned to the bottom. The parts are `root`, `menu`, `nav`, `header`, `group`, `heading`, `list`, `item`, `link`, `icon`, `initial`, `text`, `badge`, `children`, `footer`, `toggle` and `toggleIcon`.

SideNav is an island: it holds the collapsed and open state.
