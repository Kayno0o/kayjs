---
description: Stars filled to a value, part of a star included.
---

<Demo name="rating/basic" />

## Fractions

`value` is any number from 0 to `max`, so an average such as 4.6 fills part of its fifth star.

<Demo name="rating/fractions" />

## Another scale

`max` is 5 by default. `label` is required and is the text screen readers read, such as `Rated 4 out of 5`, as Meter's and Progress's are; `kay check` refuses a Rating without one.

`showLabel` writes `label` above the stars and names it by that text, and the `field` part wraps the two with the label as `heading`; `label` names it for screen readers alone otherwise. Every control with a `label` takes `showLabel`, as on [Segmented](/ui/segmented#label).

<Demo name="rating/scale" />

## In a list

The stars are inline, so a rating sits next to a count or a name like any text.

<Demo name="rating/review" />

## Picking a rating

`onChange` or `name` turns the stars into a picker over real radios: a click, the arrow keys and a form reset pick, a hover previews, and the rating posts under `name` inside a form. `value` is then a whole number, 0 for none, and `label` names the group, such as `Your rating`.

```kay
Rating(value={rating()} label="Your rating" name="rating" onChange={value => rating = value ?? 0} allowClear)
```

`onChange` hears `null` for a rating cleared (`allowClear` makes a click on the star already picked clear it) and for a reset to none. A promise from it holds the group busy and puts the previous rating back when it resolves to `false`, rejects or throws, as [Segmented](/ui/segmented) does. `disabled` keeps the rating as it is.

## Another glyph

`icon` swaps the star for a slot of the icon set or an imported icon: `Rating(value={3} max={3} label="Liked" icon="success")`. The parts of a picker are `star` (one per radio, with `data-on` while lit), `input` and `glyph`.

## Required

`required` asks for one of the stars to be picked. Each radio gets the native `required`, so the browser's validation and a post with no JavaScript know it, and the group gets `aria-required="true"`. A [FormField](/ui/form-field) with `required` around a Rating marks the same in the browser.
