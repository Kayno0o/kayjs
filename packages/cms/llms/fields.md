# Field kinds and entering a field

How the editor enters a field comes from the schema's own keywords first, then from `fieldInput(schema, options)` from `kay/content`, so an app declares only what the schema cannot say.

## What the schema already says

- `format: 'email'` is an `<input type="email">`, `'uri'` or `'url'` a `type="url"`, and either stays one line whatever its `maxLength` (a string allowed over 120 characters is otherwise a textarea).
- `maxLength` limits the box and shows a `12 / 254` counter on the label's line.
- `minimum` and `maximum` set `min` and `max` on a number or an integer.
- An `integer` takes no decimal key and cuts a pasted decimal to its whole part; the mouse wheel over any number box leaves it instead of changing the figure.
- Emptying an optional text unsets the field instead of storing `''`; a required one keeps `''` for the schema to refuse.
- A boolean toggle shows its `description` and its issue.

## `fieldInput`

```ts
import { fieldInput } from 'kay/content'

s.Object({
  price: fieldInput(s.Number({ minimum: 0 }), { suffix: '€', placeholder: '600' }),
  phone: fieldInput(s.String(), { type: 'tel' }),
  bio: fieldInput(s.String(), { rows: 6 }),
  status: fieldInput(s.Union([s.Literal('draft'), s.Literal('live')]), { labels: { draft: 'Brouillon', live: 'En ligne' } }),
  tags: fieldInput(s.Array(s.String()), { lines: true }),
  people: fieldInput(s.Array(s.Object({ name: s.String(), role: s.String() })), { titleField: 'role' }),
  linkLabel: fieldInput(s.Optional(s.String()), { when: 'link' }),
})
```

It wraps any schema, an optional or nullable one too, keeps its kind and keywords and reports the options as `x-kay-input`.

- `placeholder`: shown in the empty control.
- `prefix`, `suffix`: a word before or after a text or number box, a currency or a unit; `600 €` is a number with `suffix: '€'`, stored as `600`.
- `rows`: a string entered in a textarea of that many rows (2 or more), growing with its text.
- `type`: `'text' | 'email' | 'url' | 'tel' | 'search'` for a one-line string.
- `labels`: the label of each `enum` value or union literal by value, which wins over a literal's own `title` (`s.Literal('new', { title: 'Nouveau' })`); the stored value stays the raw one.
- `lines`: a list of strings entered in one box, a line each, blank lines dropped.
- `titleField`: the field of a list's object items whose text heads an item, before the first filled text field.
- `when`: a sibling field (same object) this one is shown for only once the sibling holds a value (not empty, `false` or `[]`). Use it on an optional field: a required one hidden cannot be filled and fails the save.

A collection's `description` (`collection({ description })`) is shown to the editor under the title of its list and of its entries.

## Field kinds of your own

A field the admin should edit another way, a colour, a map point, a rating, is declared once in the schema and given a component, with nothing to register:

```ts
import { customField } from 'kay/content'

s.Object({ accent: s.Optional(customField('color', s.String({ pattern: '^#[0-9a-f]{6}$' }))) })
```

```kay
---
// src/cms/fields/color.kay
import type { CustomFieldProps } from '@kaynooo/kayjs-cms'

const { value, onChange, label } = props<CustomFieldProps>()
---
label {label}
  input(type="color" value={typeof value === 'string' ? value : '#000000'} onInput={event => onChange(event.currentTarget.value)})
```

- The kind's name is the file's name in `src/cms/fields/`: the editor bundles every file there, so adding one needs no config. A file added or removed while `kay dev` runs is picked up on the next reload. A kind named like a built-in one (`text`, `textarea`, `markdown`, `number`, `integer`, `boolean`, `date`, `datetime`, `image`, `file`, `json`, `reference`) is refused by `customField`, as the built-in editor would win.
- The component gets `CustomFieldProps`: `value` (`undefined` while unset), `onChange(next)`, `label`, `hint`, `issue` (why the last save refused it) and `required`. It renders in the admin form and in the editor on the page, in a list or a group too.
- A save validates the value by the schema given to `customField` alone, so a `pattern`, a range or a union refuses a bad value as for any field; `customField` keeps the schema's own type.
- A kind with no file there is edited as JSON, with a hint naming the file to add that shows in development and test only. The server logs a warning at boot for each such kind, naming the collections that use it, when the project has a `src` folder.
- The list of entries shows a title, never a field, and the value on the page is read by the page as for any field.

