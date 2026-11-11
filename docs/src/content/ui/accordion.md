---
description: A group of collapsible sections where opening one closes the others, built on native disclosures.
---

<Demo name="accordion/basic" />

`items` lists the `key` and `label` of each section, and `@panel(key)` draws the body for a key. The sections are native `details` elements sharing a `name`, so opening one closes the others without script. `open` on an item starts it unfolded; with one open at a time, the first flagged one wins. The arrow keys, Home and End move between the headers once the page runs script. A single section alone is a [CollapsibleSection](/ui/collapsible-section).

## Several open at once

`multiple` lets every section be opened and closed on its own, and each item's `open` is honored.

<Demo name="accordion/multiple" />

`boxed` draws each section as a card, with neighbours sharing their border, as CollapsibleSection does; sections are plain headings otherwise.

## Keeping which sections are open

`value` is the value open, or an array of them with `multiple`, and the accordion follows it when the page passes a new one. `onChange(values)` is called with the values open whenever the reader opens or closes a section, so a page can keep them in a URL or a cookie. Closing a section as another opens reports only the opening. `value` left out, the reader alone decides after the first draw.

An item can be `disabled`, which keeps its section as it is, and can carry a `meta` text in its band. `@title(key)` and `@meta(key)` draw the heading and the band in place of an item's `label` and `meta`.
