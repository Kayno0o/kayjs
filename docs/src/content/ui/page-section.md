---
description: A titled section of a page, with room for actions at the end of its head line.
---

<Demo name="page-section/basic" />

## Title

The `title` is an `h2`, one level under the page's own, or the heading `level` given, `1` for a section holding a whole page. Stack several sections to split a page, each keeping the same head.

<Demo name="page-section/sections" />

## Actions

The `@actions` block sits at the end of the head line, for a button, a link or a row of controls.

<Demo name="page-section/actions" />

## Subtitle and sticky head

`subtitle` adds a muted line under the title. `sticky` keeps the head at the top of the scrolling area the section is in while its content runs under it, on one line: the title is cut before the actions are. A fixed bar above the area is cleared with `--kui-sticky-top`.

<Demo name="page-section/sticky" />
