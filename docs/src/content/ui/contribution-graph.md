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
