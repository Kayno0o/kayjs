---
description: A group of collapsible sections where opening one closes the others, built on native disclosures.
---

<Demo name="accordion/basic" />

`items` lists the `value` and `title` of each section, and `@panel(value)` draws the body for a value. The sections are native `details` elements sharing a `name`, so opening one closes the others without script. `open` on an item starts it unfolded; with one open at a time, the first flagged one wins. The arrow keys, Home and End move between the headers once the page runs script. A single section alone is a [CollapsibleSection](/ui/collapsible-section).

## Several open at once

`multiple` lets every section be opened and closed on its own, and each item's `open` is honored.

<Demo name="accordion/multiple" />

`boxed` is on by default and draws each section as a card, with neighbours sharing their border. `boxed={false}` draws plain headings.
