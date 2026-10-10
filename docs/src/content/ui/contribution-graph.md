---
description: A calendar grid of days shaded by how full each one is, like a commit history.
---

<Demo name="contribution-graph/basic" />

`days` lists ascending days starting on a Monday, each with a `day` (an ISO date) and an `intensity` from 0 to 1. The filled cells shade towards `color`, and `today` marks its cell. `months` names each month above the week it starts in.

<Callout type="tip">

A day can carry a `description`, shown with its date as the cell's tooltip.

</Callout>
