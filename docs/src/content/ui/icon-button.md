---
description: A button showing only an icon, named by a label that doubles as its tooltip.
---

<Demo name="icon-button/basic" />

`icon` is one of the library's icon names, and `label` is required: it names the action for screen readers and shows as the tooltip.

## Variants

`variant` is the form, `solid` (the default), `ghost` or `inline`, and `tone` the meaning, `neutral` (the default), `accent` or `danger`.

<Demo name="icon-button/variants" />

## Sizes

`size` goes from `xs` to `lg`.

<Demo name="icon-button/sizes" />

## Any icon

`icon` also takes an imported icon from any set kay imports, `~icons/<prefix>/<name>`.

<Demo name="icon-button/custom" />

## Your own drawing

`icon` also takes a snippet, `@icon` under the IconButton, for a drawing no icon set has. It pulls the default icon set into the page, so an island that sets no icon of its own may rather draw its own `button`.

## Type

`type` is `button` by default, so an IconButton in a form does not submit it. Set `type="submit"` or `"reset"` for the form's own buttons.
