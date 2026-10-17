---
description: A titled section that folds and unfolds, built on a native disclosure.
---

<Demo name="collapsible-section/basic" />

It is a native `details` element, so it folds without script and a static page can hold it. `open={false}` starts it folded, and `onOpenChange(open)` runs when the reader folds or unfolds it, for a page keeping the state.

## Boxed, with meta

`boxed` draws it as a card, so a stack of sections reads as separate blocks. `@meta` sits in the title band before the chevron, for a count the folded section would otherwise hide.

<Demo name="collapsible-section/boxed" />
