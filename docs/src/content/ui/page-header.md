---
description: The head of a page, its one h1 and the actions on the whole page.
---

<Demo name="page-header/basic" />

## Actions

The `@actions` block sits after the title, past a divider, for a button, a link or a row of controls. The children render under the title line, for a sentence saying what the page holds.

<Demo name="page-header/actions" />

## Meta and description

The `@meta` block sits beside the title, for a badge, a count or a link back. `description` is a line under the title, saying what the page holds. Children still render below it.

<Demo name="page-header/meta" />

A long word with no space to break at, such as an image reference or a digest, breaks inside the title and the description instead of widening a phone's page. Card, Notice and Table do the same, so you need no `wrap-anywhere` of your own.
