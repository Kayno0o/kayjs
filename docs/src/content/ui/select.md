---
description: A native select box for a list of options, with an optional empty choice.
---

<Demo name="select/basic" />

An option is `{ value, label, disabled? }`; a `disabled` one cannot be picked. A native option draws no icon, so unlike the other groups' options it has none.

## Typed values

`value` and `onChange` take the type of the options' values. A union of strings stays that union, and a number option hands back a number. With `emptyOption`, they take the empty string too, so hold the value as `Kind | ''`.

```kay
Select(value={kind()} options={KINDS} onChange={kind.set} emptyOption="Any kind" aria-label="Kind")
```

## Loading options

When the options come from a request, set `busy` to show a disabled row in their place, and `loadingLabel` to word it. The chosen `value` stays selected once the options arrive.

<Demo name="select/loading" />

## Holding a query param

`param="period"` makes the select hold a query param of the page. A pick goes to the current page with the param set to the option and every other param kept. The empty option and `paramDefault`, the value the page shows while the param is left out, leave the param out. Pass `value` as the page read it.

```kay
Select(value={period} options={PERIODS} param="period" paramDefault="7d" aria-label="Period")
```

An `onChange` of your own runs first, and a `false` from it, a failure, or a page that stays because a leave guard declined puts the select back on the option the page shows. It is busy while the move is under way.

`emptyOption` and `paramDefault` are alternatives: both leave the param out, so the page shows its default for "Any" too.

The select takes `param` as its name. Inside a GET form with a button it works without JavaScript, and alone it needs JavaScript. That form posts an empty `period=` for the empty option, which the page should read as absent.

## Submitting on pick

Set `submit` on a Select inside a form to submit that form once an option is picked, after `onChange`. A GET filter form then needs no ref to itself.

A pick with the mouse submits at once. Some browsers report a change on every arrow key, so a pick with the keyboard waits for Enter, or for the select to lose focus, and a person moving through the options does not post once per key.

## Options from an action

`options` can be a promise of the options or a function returning them, such as an action: it is called with `{ q }`. It is asked when the select is drawn in the browser, and the select is busy under `loadingLabel` until the answer lands. When it fails the select says `failureLabel`. `onLoad(options, query)` and `onError({ error, query })` follow each answer, as on Combobox and MultiSelect.

## Searching the options

A native select has no search box, so give it the text from one of your own: `query={text()}`. The function is asked again each time `query` changes, and only the latest answer is shown. The answer replaces the options, so it should still list the option that is picked.

```kay
TextInput(value={text()} onInput={text.set} aria-label="Search planets")
Select(options={({ q }) => findPlanets(q)} query={text()} aria-label="Planet")
```


## Size and invalid

`size` is `sm`, `md` or `lg`, `md` by default, and changes the padding and the type. `invalid` draws the line and the focus ring in the danger colour and sets `aria-invalid="true"`, for a refusal the page knows of. A FormField marks its control itself while it shows a message.
