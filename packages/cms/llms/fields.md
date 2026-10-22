# Field kinds and entering a field

How the editor enters a field comes from the schema's own keywords first, then from `fieldInput(schema, options)` from `kay/content`, so an app declares only what the schema cannot say.

## Common tasks

### Tune how a field is entered

`fieldInput(schema, options)` wraps any schema, an optional or nullable one too, and reports the options as `x-kay-input`:

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

### Ready-made kinds

Fields a site rebuilds each time, from `kay/content`; a schema names the kind, the editor has the control, and nothing is registered:

```ts
import tabler from '@iconify-json/tabler/icons.json'
import { colorField, geoField, iconField, linkField, moneyField, tagsField } from 'kay/content'

s.Object({
  accent: colorField(),
  price: moneyField({ currency: 'EUR' }),
  labels: tagsField({ maxItems: 8 }),
  cta: linkField(),
  place: geoField(),
  icon: iconField(tabler),
})
```

### Blocks

A page made of mixed sections is a list of items of several declared types, `blocks()` from `kay/content`:

```ts
import { blocks } from 'kay/content'

s.Object({
  sections: blocks({
    hero: s.Object({ heading: s.String({ minLength: 1 }), image: s.Optional(imageField()) }, { title: 'Hero banner' }),
    text: s.Object({ body: markdownField() }),
    gallery: s.Object({ images: s.Array(imageField()) }),
  }),
})
```

### Field kinds of your own

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

## Reference

### What the schema already says

- `format: 'email'` is an `<input type="email">`, `'uri'` or `'url'` a `type="url"`, and either stays one line whatever its `maxLength` (a string allowed over 120 characters is otherwise a textarea).
- `maxLength` limits the box and shows a `12 / 254` counter on the label's line.
- `minimum` and `maximum` set `min` and `max` on a number or an integer.
- An `integer` takes no decimal key and cuts a pasted decimal to its whole part; the mouse wheel over any number box leaves it instead of changing the figure.
- Emptying an optional text unsets the field instead of storing `''`; a required one keeps `''` for the schema to refuse.
- A boolean toggle shows its `description` and its issue.
- A `reference('authors')` field is a menu of that collection's entries by title (typed as a slug if they cannot be read). A save is refused for a reference to an entry that does not exist, unless the entry already held it, so publishing never stops on an old one; deleting an entry names the entries that refer to it.

### `fieldInput`

It wraps any schema, an optional or nullable one too, keeps its kind and keywords and reports the options as `x-kay-input`. A nullable field listed as required stores `null` when cleared, not a missing key.
A hand-written `x-kay` string (`{ 'x-kay': 'text' }`, as apps wrote before `fieldInput`) is read as the kind it names, a built-in one or the app's own; one that is neither a string nor an object with a `kind` is ignored and the boot logs it with the collection and field path.

- `placeholder`: shown in the empty control.
- `prefix`, `suffix`: a word before or after a text or number box, a currency or a unit; `600 €` is a number with `suffix: '€'`, stored as `600`.
- `rows`: a string entered in a textarea of that many rows (2 or more), growing with its text.
- `type`: `'text' | 'email' | 'url' | 'tel' | 'search'` for a one-line string.
- `labels`: the label of each `enum` value or union literal by value, which wins over a literal's own `title` (`s.Literal('new', { title: 'Nouveau' })`); the stored value stays the raw one.
- `lines`: a list of strings entered in one box, a line each, blank lines dropped; emptied on an optional field it unsets the key.
- `titleField`: the field of a list's object items whose text heads an item, before the first filled text field.
- A list has Add at the top, a jump menu from 8 items, an issue count on a folded item's head, and the entry's Reset asks to confirm (`cms.list.*`, `cms.entry.resetMessage`).
- `when`: a sibling field (same object) this one is shown for only once the sibling holds a value (not empty, `false` or `[]`). The sibling must be a key of the same object, or the server logs a warning at boot. Use it on an optional field: a required one hidden cannot be filled and fails the save, and a hidden field keeps its stored value. A hidden field the schema refuses is shown with its message.
- `placeholder`, `prefix` and `suffix` apply to text and number boxes only; `rows` auto-growing needs a browser with `field-sizing`, else the box stays at its `rows`; it sets no style attribute, so a strict content security policy keeps it.

A collection's `description` (`collection({ description })`) is shown to the editor under the title of its list and of its entries.

### The ready-made kinds

- `colorField()`: `#rrggbb`, a colour picker beside the code; the schema refuses any other text.
- `moneyField({ currency? })`: a number, never below zero unless `minimum` says so, with the currency's symbol after the box (`'EUR'` gives `€`, an ISO 4217 code); the stored figure is the one typed, not cents.
- `tagsField()`: a list of distinct, non-empty words, entered as chips: Enter or a comma adds, Backspace on the empty box removes the last. It takes a list's own options (`maxItems`).
- `linkField()`: `{ label, href }`, the `href` a path or an http(s) address. `geoField()`: `{ lat, lng }` in degrees. Both are plain objects the form shows as a group, so a layout can place their parts by path.
- `iconField(set)`: the name of an icon of an iconify set, `tabler:home`, picked from a grid with search. The set is the JSON the app already imports (`@iconify-json/<prefix>/icons.json`); it stays on the server, which the editor asks for 50 icons at a time through `/_kay/cms/icons`, readable by whoever may edit. The schema checks the name's shape, not that the set holds it; the page draws the stored name as it is with `iconProps(set, name)` from `kay/icons`.

A long list of options (more than 12) picked with a union of literals or an `enum` opens on a search box; the native list has no icons, so a pick among icons is an `iconField`. A date has Today and Clear, a date and time Now and Clear; Clear is hidden on a required field.

How other schema types show: a `s.Date()` is a date input (use `format: 'date-time'` text for a time), a `t.Transform` is entered as the type it decodes from, and a `t.BigInt()` has no control, so it is edited as JSON: prefer `s.Integer()`.

### How blocks behave

- Each key is a block type and its object the fields of an item of it. An item is stored as an object with a `type` key naming its type, `{ type: 'hero', heading: 'Welcome' }`, so a Markdown or JSON file holds a plain array.
- The typed read is the union of the blocks discriminated on `type`: `section.type === 'hero'` narrows to `section.heading`. A block may not declare a `type` field of its own, and `blocks()` throws saying so; it also throws for no block, an empty type name or a block that is not an object.
- A block's `title` is its label in the editor, else its key humanized (`hero` gives `Hero`). `blocks(types, { minItems, maxItems })` takes a list's own options, and `s.Optional(blocks(...))` makes the list optional.
- The editor adds a block by its type: an `Add <type>` button for each at the end of the list and a menu of the types to add at the top. Each item shows the fields of its own type, headed by its label then its first filled text (`Hero banner: Welcome`), and folds, moves (across types), duplicates and removes with Undo as any list item does. `fieldsOf` gives a `list` field with `blocks`, each `{ type, label, fields }`, and `itemAt(list, index, value)` the group of one item.
- An item saved with an unknown `type` shows as `Unknown block` with no field, left to be removed, and the save refuses it.
- A block failing its schema is refused at its own field (`sections.1.heading`), the issue worded with that field's label. `withDefaults` fills the defaults of a block by its type, and a reference inside a block is checked like any other.
- In edit mode a block's fields are marked by their place in the list (`sections.1.heading`) like any list's, and a block's `type` read to pick its markup is no field of the page, so it is never listed among the fields a click cannot reach. A click on a field inside a folded block unfolds it, and every folded block around it, then focuses the field.
- The texts of the editor are the `cms.blocks.*` messages ([Texts and languages](words.md)).

### How field kinds of your own behave

- The kind's name is the file's name in `src/cms/fields/`: the editor bundles every file there, so adding one needs no config. A file added or removed while `kay dev` runs is picked up on the next reload. A kind named like a built-in one (`text`, `textarea`, `markdown`, `number`, `integer`, `boolean`, `date`, `datetime`, `image`, `file`, `json`, `reference`) is refused by `customField`, as the built-in editor would win.
- The component gets `CustomFieldProps`: `value` (`undefined` while unset), `onChange(next)`, `label`, `hint`, `issue` (why the last save refused it) and `required`. It renders in the admin form and in the editor on the page, in a list or a group too.
- A save validates the value by the schema given to `customField` alone, so a `pattern`, a range or a union refuses a bad value as for any field; `customField` keeps the schema's own type.
- A kind with no file there is edited as JSON, with a hint naming the file to add that shows in development and test only. The server logs a warning at boot for each such kind, naming the collections that use it, when the project has a `src` folder.
- The list of entries shows a title, never a field, and the value on the page is read by the page as for any field.
