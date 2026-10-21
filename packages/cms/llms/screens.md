# Arranging and replacing the screens

The screens read each collection's schema, so most sites need none of this. Three steps, from nothing to write to a screen of your own.

## Arrange a collection

`cms({ collections })` arranges the form and the list of a collection by its name. The screens and the editor on the page both follow it.

```ts
cms({ collections: { shop: {
  form: { fields: ['price', ['stock', 'live'], 'photo'], hide: ['sku'] },
  list: { columns: ['price', 'live'], actions: ['delete'] },
} } })
```

- `form.fields` are shown first, in that order. An inner array is one row of columns, which stack where there is no room, the editor's narrow panel included. The fields not named follow in the schema's order, then the Markdown body.
- `form.hide` leaves a field out. The body is `body`, or `#body` when a data field is called `body`.
- A hidden field that a save refuses (a required one, say) still shows its issue above the form, so the editor is never told nothing. See [Fixing a refused save](#fixing-a-refused-save) for what the form does with the others.
- `list.columns` are field keys shown after the title, each headed by the field's label and sortable. A text, number, boolean (Yes or No), select (its label), date, image or file (its file name) or reference field can be a column; a list, group, JSON or custom field cannot.
- `list.actions` keeps some of a row's actions, `'move'`, `'publish'`, `'editOnPage'`, `'delete'`; all by default. `actions: []` removes the Actions column.
- A shape that means nothing, a name twice, a name both shown and hidden or an unknown action throws as `kay.config.ts` loads. A name the schema lacks logs a warning at boot, and the screens skip it.

## Replace a screen

A page of the app at a screen's path replaces it: `src/routes/admin/collections/shop/[...slug].kay` serves the shop's entries in place of `<prefix>/collections/[collection]/[...slug]`, and the other screens stay. A `src/routes/admin/_layout.kay` replaces the cms's own layout for every screen. That one holds the chrome (skip link, nav with Content, Missing pages and Unused uploads, a link back to the site), kayjs-ui's `Toaster` and `TooltipHost` and the stylesheet `@kaynooo/kayjs-cms/admin.css`, which imports Tailwind and kayjs-ui's theme, so a layout of your own renders the chrome and the toaster, imports the stylesheet and sets `export const page = { layouts: false, noindex: true }` to stay clear of the site's layouts as the default does. The extension's guard still runs before a replacing page, as guards resolve per URL directory across both trees, unless the app has a `_guard.ts` of its own at that level.

`entryScreen`, `listScreen` and `collectionScreen` from `@kaynooo/kayjs-cms` read what the screen reads, in a page's `--- server` fence, and return `undefined` for a collection the site lacks:

```kay
--- server
import { entryScreen } from '@kaynooo/kayjs-cms'
import { s } from 'kay'
import ShopEntry from '../../../../components/shop-entry.kay'

export const page = { query: s.Object({ locale: s.Optional(s.String()) }) }

const screen = await entryScreen({ collection: 'shop', slug: ctx.params.slug, locale: ctx.query.locale }) ?? ctx.notFound()
const entry = screen.entry ?? ctx.notFound()
---
ShopEntry(prefix={screen.prefix} collection={screen.collection} entry={entry})
```

- `entryScreen({ collection, slug, locale })` gives `{ prefix, collection, entry }`. `entry` is `undefined` when the collection cannot be read (its `problem` says why) or holds no such entry. A page reading `?locale=` names it in `export const page = { query: s.Object({ locale: s.Optional(s.String()) }) }`.
- `collectionScreen(name)` gives `{ prefix, collection }`, for a new entry's screen, which has no entry to read.
- `listScreen({ collection, q, page })` gives `{ prefix, collection, rows, page, pages }`, the rows of a page of the list as the default list draws them, `cells` for the layout's columns included.
- The collection carries its layout as `collection.layout`, so the parts below need no other prop.

## Build a screen from the parts

The entry screen is an island of the app, made from the parts the default one is made of. `createEntryForm` from `@kaynooo/kayjs-cms/form` keeps the state, and every part takes the `form`.

```kay
---
import type { ScreenCollection, StoredEntry } from '@kaynooo/kayjs-cms'
import EntryActions from '@kaynooo/kayjs-cms/entry-actions.kay'
import EntryField from '@kaynooo/kayjs-cms/entry-field.kay'
import EntryHeader from '@kaynooo/kayjs-cms/entry-header.kay'
import EntryIdentity from '@kaynooo/kayjs-cms/entry-identity.kay'
import EntryNotices from '@kaynooo/kayjs-cms/entry-notices.kay'
import { createEntryForm } from '@kaynooo/kayjs-cms/form'

const { prefix, collection, entry } = props<{ prefix: string, collection: ScreenCollection, entry?: StoredEntry | undefined }>()

const form = createEntryForm({ prefix, collection, entry })
---
form(novalidate onSubmit={event => { event.preventDefault(); void form.save() }})
  EntryHeader(prefix={prefix} collection={collection} title={form.name} subtitle={form.subtitle})
    EntryActions(form={form})
  EntryIdentity(form={form})
  EntryNotices(form={form})
  EntryField(form={form} name="photo")
  EntryField(form={form} name="name")
  .kcms-row
    EntryField(form={form} name="price")
    EntryField(form={form} name="stock")
```

- `createEntryForm({ prefix, collection, entry?, locale? })` (`entry` may be a function returning it, `() => all.entry` for a `persist` island that takes new props when the page refreshes in place, so `stored`, `name`, `subtitle` and `problem` follow it) is what the default screen runs: the drafts, the save (a new entry is created under the slug typed, then opened; Ctrl or Cmd+S saves while the screen is open), publish, unpublish, publish now, clear schedule, delete, reset, the leave guard, and the words the form reads. It returns `{ drafts, entry, collection, problem, shown, prefix, name, subtitle, slug, newLocale, saving, dirty(), canSave(), savedAt(), stored, isDraft(), scheduled(), save(), publish(), unpublish(), publishNow(), unschedule(), remove(), reset() }`; `publish()`, `unpublish()`, `publishNow()` and `unschedule()` save that one field and refuse over unsaved edits, putting the field back when the save is refused; `canSave()` is false with nothing to save or while saving; `savedAt()` is `{ at, rebuilding }` of the last save that went through; `slug` and `newLocale` are signals, `entry` is the entry's reference (`{ collection, slug, locale }`).
- `entry-header.kay` (`prefix`, `collection`, `title`, `subtitle`; the `slot` is its actions), `entry-actions.kay` (the Draft badge, Edit on page, Publish or Unpublish, Publish now and Clear schedule for a scheduled entry, Delete, Reset, Save or Create, and where the entry stands), `entry-presence.kay` (`room`, `member`, from `entryPresence`, or `entryRoom(collection, entry, { name: '' })` from `@kaynooo/kayjs-cms/room` for the on-page editor, which shows it too: who else has this entry open, their names when `cms({ author })` gives them, else how many), `entry-identity.kay` (a new entry's slug and locale, nothing for a saved one) and `entry-notices.kay` (a file that does not parse, a save refused with its Keep my edits after a conflict, issues on the entry, and issues on a field or the body that nothing on the screen renders).
- `entry-field.kay` (`form`, `name`) renders one field by its key in the schema, a group or a list with the fields inside it; a name the schema lacks throws, naming the schema's. `entry-body.kay` (`form`) renders the Markdown body. `entry-fields.kay` (`form`) renders all of them as the layout arranges them, notices first.
- `field-input.kay` (`drafts`, `entry`, `field`, `path`) renders any field at a dotted path, as a list item or a group's child; `file-input.kay` is an image or file field's control.
- A field the screen leaves out is not rendered, so a save that refuses it is shown in `EntryNotices`. Saves, conflicts (the fields both sides changed, Keep my edits, Take their version), uploads and issues are those of the default screen.
- `entry-editor.kay` (`prefix`, `collection`, `entry?`, `locale?`, `presence?` as `entryPresence(ctx, collection, entry)` from `@kaynooo/kayjs-cms/presence` returns it, for a server page) is the default entry form as one component, listing who else has the entry open when it is given `presence`, and `entry-table.kay` (`prefix`, `collection`, `rows`, `searched`) the default list, marking an entry `Being edited` (by name when the editors have one) through `entry-watch.kay` (`collection`, `entry`) for the first 50 rows, which watches through a room of its own that every editor is also listed in, so it is no editor to anyone, both usable as they are on a page of your own.
- No new text: the parts use the `cms.*` keys of [Texts and languages](words.md).

## Fixing a refused save

- A refused save puts the focus on the first field it marked invalid (`aria-invalid`, scrolled into view), or on the first notice above the form when it marked none, and a summary above the form lists every refused field as a link that focuses it (`#kcms-<collection>-<slug>-<locale>-f:<path>` ids, `b` for the body, `s` and `l` for a new entry's slug and locale). The summary is not announced itself, as each field's message is a live region. It lists every issue the entry has, so on the on-page editor those its preview finds as the editor types appear in it too. An issue on a field the screen does not draw stays a notice of its own, with no link.
- An edit answers its own field's issue and no other's: `drafts.set` drops the issues of its path, so the rest stand until their fields are edited or the next save or preview render names the issues anew. A render that names no issues, as a form's with no preview, leaves them be.
- A schema's `minLength`, `maxLength`, `pattern`, `minimum` and `maximum` are `minlength`, `maxlength`, `pattern`, `min` and `max` attributes of the control, and a required field's control (text, number, markdown, date, date and time, select) is `required`. The `pattern` attribute is set only for a pattern anchored at both ends (`^...$`) in one alternative, which HTML and the schema read alike; any other is checked by the form alone. Once the editor leaves a box (the markdown editor too), its limits are checked as they type, worded as the server words them (`cms.check.*`); a limit the server judges differently (empty text, a pattern a `RegExp` cannot compile) is left to it, and the server stays the one that decides.
- A JSON box (a `json` field, or a custom kind with no editor) takes each text that parses as it is typed. One that does not keeps the last value, shows `{field} is not valid JSON` once left, and a save refuses without sending anything: Save stays enabled so pressing it says what to fix (`drafts.block(ref, path, message)`, `drafts.blocked(ref)`).
- A new entry's slug and locale show their own refusal, a taken slug included, as the other fields do; typing a new slug or picking a locale answers it (`drafts.dismissWhere(ref, match)`).
