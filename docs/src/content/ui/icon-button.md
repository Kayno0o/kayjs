---
description: A button showing only an icon, named by a label that doubles as its tooltip.
---

<Demo name="icon-button/basic" />

`icon` is one of the library's icon names, and `label` is required: it names the action for screen readers and shows as the tooltip.

## Variants

`variant` is the form, `solid` (the default), `ghost` or `inline`, and `tone` the meaning, `neutral` (the default), `accent` or `danger`.

`href` renders a link with the same look, parts and tooltip instead of a button, for an action that navigates. `BareIconButton` takes it too.

<Demo name="icon-button/variants" />

## Sizes

`size` goes from `xs` to `lg`.

<Demo name="icon-button/sizes" />

## Any icon

`icon` also takes an imported icon from any set kay imports, `~icons/<prefix>/<name>`.

<Demo name="icon-button/custom" />

## Your own drawing

`icon` also takes a snippet, `@icon` under the IconButton, for a drawing no icon set has. IconButton still ships the default icon set, so an island drawing only its own `svg` imports `@kaynooo/kayjs-ui/bare-icon-button.kay` instead: the same button and props with the drawing nested inside it, and no icon lookup.

## Type

`type` is `button` by default, so an IconButton in a form does not submit it. Set `type="submit"` or `"reset"` for the form's own buttons.
