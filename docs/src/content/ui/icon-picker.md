---
description: A search box over a grid of icons, for picking one by name.
---

<Demo name="icon-picker/basic" />

## Searching

`search(query, limit)` returns the matching icons as `{ name, icon }` choices, where `icon` is what to draw. An app usually makes it an action reading an icon set on the server, so the set never ships to the browser. Typing is debounced, and the grid asks for more when "Show more" is pressed.

<Demo name="icon-picker/more" />

## In a form

`name` submits the chosen name inside a plain form, and an `input` event tells the form about each pick. Without a form, `value` is the chosen name and `onChange` gets the new name, or an empty string when the pick is cleared.

<Demo name="icon-picker/form" />

<Callout type="note">

The picker takes a function, so it renders inside an island.

</Callout>
