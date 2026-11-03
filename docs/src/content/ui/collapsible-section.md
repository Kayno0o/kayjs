---
description: A titled section that folds and unfolds, built on a native disclosure.
---

<Demo name="collapsible-section/basic" />

It is a native `details` element, so it folds without script and a static page can hold it. `open={false}` starts it folded. `open` follows the page when it changes the value, and `onOpenChange(open)` is called whenever the section folds or unfolds, however it did, so a page can keep which sections are open or load a body on its first opening.

A listener makes the section an island, as any handler does, so a page that passes none stays static. `disabled` keeps a section as it is, and `title` takes a block as well as a string.

## Boxed, with meta

`boxed` draws it as a card, so a stack of sections reads as separate blocks. `@meta` sits in the title band before the chevron, for a count the folded section would otherwise hide.

<Demo name="collapsible-section/boxed" />
