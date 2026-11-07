---
description: An icon button opening a menu of actions.
---

<Demo name="menu/basic" />

## Entries

`items` lists the entries: an object with a `label`, an `onSelect`, an optional `icon` and `danger` for a destructive one, or `'separator'` to draw a rule between groups. `icon` sets the trigger's icon and `label` names it. `onSelect` runs once the menu has closed and focus is back on the trigger. A menu taller than the window scrolls, and its entries are taller on a touch screen.

## Options, groups and submenus

An entry with `checked` and `onCheckedChange(checked)` is a check item (`role="menuitemcheckbox"`). Hold its state in the page and set `checked`, or leave `checked` out and the menu keeps it, starting from `defaultChecked`. Entries sharing a `radioGroup` are radio items (`role="menuitemradio"`), each with a `value`: set `checked` on each, or let the menu keep the group, starting from the entry with `defaultChecked`, and `onCheckedChange(value)` hears the one that became checked.

An entry is a checkbox when it carries `checked`, `defaultChecked` or `onCheckedChange`, and a radio when it has a `radioGroup`; the menu keeps the state of a checkbox left uncontrolled under its `id`, else its position in the list, and an uncontrolled radio group shows nothing checked until one is picked or an entry has `defaultChecked`.

By default picking an entry closes the menu. `closeOnSelect: false` on an entry keeps it open, such as to flip several options in a row; its callback then runs at once.

`{ heading: 'Sort by' }` draws a title over the entries after it. `shortcut: 'Ctrl+S'` draws a hint at the end of the row; it only shows the combination, and kay's `shortcut()` binds it.

`{ label: 'Share', items: [...] }` is a submenu, with the same kinds of entries and the same async sources as the menu. Resting the pointer on it opens it, and moving to a sibling entry closes it; a click or ArrowRight opens it and focuses its first entry, ArrowLeft or Escape closes it, `open` and `onOpenChange` on it work as the menu's own, and picking one of its entries closes the whole menu.

A heading is announced as a group of the entries up to the next heading or rule, and radios sharing a `radioGroup` as a group of their own.

Typing letters moves the focus to the next entry whose label starts with them; a letter repeated cycles through the entries starting with it.

## Row actions

A menu fits at the end of a row. `disabled` greys an entry out, and the arrows, Home and End move between the enabled ones, an accent bar marking the one the keyboard is on.

<Demo name="menu/rows" />

## Links

An entry with an `href` is drawn as a link, so a middle-click, Ctrl+click or "copy link" works on it, and `onSelect` is optional. The menu closes as the link is followed. An absolute address (`https://...`) opens in a new tab with `rel="noopener noreferrer"`; an entry's `newTab` is `true` to always open one, `false` never, or `'auto'` (the default) for an address leaving the site. A `disabled` entry stays a disabled button.

## At a point

`at={{ x, y }}` opens the menu at a point of the window, such as the `clientX` and `clientY` of a click, with no trigger of its own and no `icon`. `open` shows it and `onOpenChange(open)` runs however it closed. It opens at `bottom-start` of the point, the browser flips it to stay inside the window, and Escape or a click outside closes it and gives focus back.

## Trigger and placement

`size` is `xs` to `lg`, `md` by default, and `variant` is `solid`, `ghost` or `inline`, `ghost` by default, with a `tone` for the trigger. An entry takes a `tone` too, `danger` for a destructive one; an entry's `danger: true` is deprecated for it. `placement` is where the menu opens from the trigger, `bottom-end` by default. `id` is the menu's id, unique on the page, and kay draws one when you give none.

## Your own trigger

A menu opened by a labelled button or a user name with an avatar gives a `@trigger(attributes)` block in place of the icon button. Spread the attributes on any element: they carry `popovertarget`, `aria-expanded`, `aria-haspopup="menu"` and the style that anchors the menu, and `aria-expanded` follows the menu. `icon`, `size`, `variant` and `tone` then have nothing to style.

```kay
Menu(label="Actions" items={items})
  @trigger(attributes)
    Button({...attributes} label="Actions")
```

Other attributes, such as a `data-testid`, an `aria-describedby` or a `style`, go on the default icon button. A `style` is written after the anchor's.

## Entries fetched when the menu opens

`items` may be a function returning the entries, or a promise of them. A function is called each time the menu opens, a loading row showing until the answer is in, and the first entry then takes focus. When it throws or rejects, a failure row shows with a `Try again` entry that loads again. `loadingLabel`, `failureLabel` and `retryLabel` replace the words.

## Drawing an entry

`@item(entry)` draws an entry's content in place of its icon and label, such as a shortcut hint, a check mark or a badge. The entry stays a button or a link, with its keys and its tone.
