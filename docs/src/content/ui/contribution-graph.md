---
description: A calendar grid of days shaded by how full each one is, like a commit history.
---

<Demo name="contribution-graph/basic" />

## Days

`days` lists ascending days starting on a Monday, each with a `day` (an ISO date) and an `intensity` from 0 to 1. `today` marks its cell, and `months` names each month above the week it starts in.

## Tooltips

A day can carry a `description`, shown with its date as the cell's tooltip and read out by screen readers, which hear how full the day was without one. `label` names the grid. Hover a cell below.

<Demo name="contribution-graph/description" />

## Colour

The filled cells shade towards `color`, any CSS colour: a theme token keeps it in step with the theme, and an empty day stays unfilled.

<Demo name="contribution-graph/colors" />

## Keyboard

The grid is one tab stop, on today's cell. The up and down arrows step a day, left and right a week, and Home and End reach the first and last day. Each focused cell shows its details like a hovered one.

## Pressing and linking

`onSelect` makes every cell a button handing back its mark, and `href` returns an address for a mark (or `undefined`) that makes it a link, so a middle click or a crawler finds it; a plain click on a link still goes to `onSelect` when given. `onActive` hears the index the pointer or focus is on, `null` when it leaves, and `active` draws one as active, taking over from the pointer.
