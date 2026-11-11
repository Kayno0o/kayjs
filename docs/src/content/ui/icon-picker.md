---
description: A search box over a grid of icons, for picking one by name.
---

<Demo name="icon-picker/basic" />

## Searching

A function `icons` is handed `{ q, limit, offset }` and returns the matching icons from the `offset`th on as `{ name, icon }` choices, where `icon` is what to draw. An app usually makes it an action reading an icon set on the server, so the set never ships to the browser. Typing is debounced, and "Show more" asks for the next page, `offset` further, and adds it to the grid.

<Demo name="icon-picker/more" />

`onSearch` is called with the query each time a new search starts, not when Show more adds a page. `onLoad` is called with the icons of each page and the query. `onError` is called with `{ error, query }`, what the search rejected with, for the latest search only, while `failureLabel` still shows and the last grid stays.

## In a form

`name` submits the chosen name inside a plain form, and an `input` event tells the form about each pick. Without a form, `value` is the chosen name and `onChange` gets the new name, or an empty string when the pick is cleared.

<Demo name="icon-picker/form" />

<Callout type="note">

The picker takes a function, so it renders inside an island.

</Callout>

## Labels

A screen reader hears how many icons a search found (`1 icon`, `12 icons`, or the empty text) from the `ui.iconPicker.results` message.

`searchLabel` names the search box and `placeholder` fills it, `Search icons` and `Search icons…` by default. `gridLabel` names the grid, `Icons`. `searchingLabel`, `emptyLabel`, `failureLabel`, `clearLabel` and `moreLabel` word the searching state, the empty result, a search that failed (`The icons could not be loaded.`), the clear button and the Show more button. Set them to translate the picker.

## A fixed set

`icons` also takes a list of `{ name, icon }` or a promise of one. The text typed filters it by name and it is paged like an answer, so a small set needs no action.
