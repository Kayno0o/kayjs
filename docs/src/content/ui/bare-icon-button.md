---
description: An IconButton around your own svg, with no icon lookup, so an island ships none of the default icons.
---

<Demo name="bare-icon-button/basic" />

It takes the props of IconButton but `icon`: what is nested inside draws the icon, and `label` is required, naming the action for screen readers and showing as the tooltip.

IconButton imports the icon lookup and with it the library's default icons, which an island drawing only its own `svg` has no use for. This button is the same markup without that import.
