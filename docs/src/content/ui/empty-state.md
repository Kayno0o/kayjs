---
description: What a list shows when it holds nothing.
---

<Demo name="empty-state/basic" />

## Title and description

`title` says what is missing and the optional `description` tells what to do about it.

## In place of a list

Render it in the `else` of the list, so it shows whenever the list is empty, a filter that matches nothing included. Type a name that does not exist.

<Demo name="empty-state/filter" />

## As the whole page

An error page or a 404 is often an empty state alone. `level={1}` makes the title the page's `h1`, so the page needs no hidden heading of its own. Any `level` from 1 to 6 works; without one, the title is a paragraph.

```kay
EmptyState(title="Page not found" description="The link may be out of date." level={1})
```

## Icon and tone

`icon` is drawn above the title, and `tone` (`info`, `success`, `warning` or `danger`) colours the icon and the title: `EmptyState(title="Could not load the posts" icon="alert" tone="danger")`.

## In a data component

Every component that shows data takes `emptyLabel`, the text it reads with nothing to show, and an `@empty` block that replaces it with markup of your own, such as an EmptyState with a button that adds the first item. Table, Timeline, TreeView, DescriptionList, the charts, Sparkline, StatusStrip, Carousel, VirtualList, MediaGallery, Combobox, MultiSelect, IconPicker and CommandPalette all do. A component that loads takes `loadingLabel`, `failureLabel` and `retryLabel` the same way.

## Actions

`actions` is drawn below the description. Put a button or a link there that leads out of the empty list, such as the one that adds the first item.
