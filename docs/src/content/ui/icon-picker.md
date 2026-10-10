---
description: A search box over a grid of icons, for picking one by name.
---

<Demo name="icon-picker/basic" />

## Searching

`search(query, limit)` returns the matching icons as `{ name, icon }` choices, where `icon` is what to draw. An app usually makes it an action reading an icon set on the server, so the set never ships to the browser. `value` is the chosen name, `onChange` gets the new name or an empty string when the pick is cleared, and `name` submits it inside a plain form.

<Callout type="note">

The picker takes a function, so it renders inside an island.

</Callout>
