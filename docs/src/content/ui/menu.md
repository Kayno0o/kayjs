---
description: An icon button opening a menu of actions.
---

<Demo name="menu/basic" />

## Entries

`items` lists the entries: an object with a `label`, an `onSelect`, an optional `icon` and `danger` for a destructive one, or `'separator'` to draw a rule between groups. `icon` sets the trigger's icon and `label` names it. `onSelect` runs once the menu has closed and focus is back on the trigger. A menu taller than the window scrolls, and its entries are taller on a touch screen.

## Row actions

A menu fits at the end of a row. `disabled` greys an entry out, and the arrows, Home and End move between the enabled ones, an accent bar marking the one the keyboard is on.

<Demo name="menu/rows" />

## Links

An entry with an `href` is drawn as a link, so a middle-click, Ctrl+click or "copy link" works on it, and `onSelect` is optional. The menu closes as the link is followed. An absolute address (`https://...`) opens in a new tab with `rel="noopener noreferrer"`. A `disabled` entry stays a disabled button.

## At a point

`at={{ x, y }}` opens the menu at a point of the window, such as the `clientX` and `clientY` of a click, with no trigger of its own and no `icon`. `open` shows it and `onOpenChange(open)` runs however it closed. It opens at `bottom-start` of the point, the browser flips it to stay inside the window, and Escape or a click outside closes it and gives focus back.

## Trigger and placement

`size` is `xs` to `lg`, `md` by default, and `variant` is `solid`, `ghost` or `inline`, `ghost` by default, with a `tone` of `neutral`, `accent` or `danger` for the trigger. An entry is destructive with `tone: 'danger'`; an entry's `danger: true` is deprecated for it. `placement` is where the menu opens from the trigger, `bottom-end` by default. `id` is the menu's id, unique on the page, and kay draws one when you give none.

## Your own trigger

A menu opened by a labelled button or a user name with an avatar gives a `@trigger(attributes)` block in place of the icon button. Spread the attributes on any element: they carry `popovertarget`, `aria-expanded`, `aria-haspopup="menu"` and the style that anchors the menu, and `aria-expanded` follows the menu. `icon`, `size`, `variant` and `tone` then have nothing to style.

```kay
Menu(label="Actions" items={items})
  @trigger(attributes)
    Button({...attributes} label="Actions")
```

Other attributes, such as a `data-testid`, an `aria-describedby` or a `style`, go on the default icon button. A `style` is written after the anchor's.
