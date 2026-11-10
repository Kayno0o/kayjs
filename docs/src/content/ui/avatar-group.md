---
description: A row of overlapping avatars with a +N chip for the people past a limit.
---

<Demo name="avatar-group/basic" />

`avatars` is a list of `{ name, src, label, href, status }`, the props of an Avatar. `max` (4 by default) is how many are drawn; when more are given, a `+N` chip takes the rest and opens a popover listing them, a person with an `href` being a link. `label` names the group for screen readers, and every avatar is named by its `label`, else its name. `size` sets the size of every avatar and of the chip. Two people with the same name need a `key` each, which tells their avatars apart.

## A chip that is a link

`moreHref` makes the chip a link, to the page listing everyone, in place of the popover. `moreLabel` names it for screen readers, a string where `{count}` stands for the people it holds or a function of that count; the default is `{count} more`.

<Demo name="avatar-group/link" />

## Data from a function

`avatars` also takes a promise of the list or a function answering it, such as an action, asked in the browser: the group is `aria-busy` until the answer lands, and shows `failureLabel` with a retry button when it fails. `onLoad(people, query)` and `onError({ error, query })` mark each answer.

## Your own markup

`@avatar(person)` replaces the avatar drawn for a person, in the stack and in the list, and `@rest(people)` replaces the popover's list. `open` and `onOpenChange` drive the popover, `placement` sets its side.
