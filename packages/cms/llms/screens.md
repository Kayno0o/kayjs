# Arranging and replacing the screens

The screens read each collection's schema, so most sites need none of this. Three steps, from nothing to write to a screen of your own.

## Common tasks

### Arrange a collection
`cms({ collections })` arranges the form and the list of a collection by its name. The screens and the editor on the page both follow it.

```ts
cms({ collections: { shop: {
  form: { fields: ['price', ['stock', 'live'], 'photo'], hide: ['sku'] },
  list: { columns: ['price', 'live'], actions: ['delete'] },
} } })
```

### The list

State is in the URL, so a view of the list is a link to share: `?q=` searches, `?status=draft|scheduled|published` filters, `?sort=<column>&dir=asc|desc` sorts and `?page=` pages.

```
/admin/collections/shop?q=lamp&status=published&sort=title&dir=asc&page=2
```

### Replace a screen with a page of your own

A page of the app at a screen's path replaces it, and `entryScreen`, `listScreen` and `collectionScreen` from `@kaynooo/kayjs-cms` read what the screen reads, in a page's `--- server` fence, and return `undefined` for a collection the site lacks:

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

### Build a screen from the parts
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

## Reference

### Arranging a collection

- `form.fields` are shown first, in that order. An inner array is one row of columns, which stack where there is no room, the editor's narrow panel included. The fields not named follow in the schema's order, then the Markdown body.
- `form.hide` leaves a field out. The body is `body`, or `#body` when a data field is called `body`.
- `form.body: { label, hint }` words the Markdown body: its label (`Body`, translated, by default) and a hint under it. `form.toolbar` sets the formatting buttons over every Markdown box of the collection, the body and `markdown` fields alike: `false` for none, or a list to keep, in order, of `bold`, `italic`, `heading`, `bulletList`, `numberedList`, `link` and `image`; all by default. `form.previewClass` puts classes on the preview's HTML, such as `prose`, so it takes the styles your pages give rendered Markdown. `form.body` on a collection with no Markdown body stops the boot, naming the collection. A box in a custom screen follows them when rendered by `entry-body.kay` or `entry-field.kay`.
- Every Markdown box has a Preview button: the text is posted to `POST /_kay/cms/markdown`, rendered by the site's own Markdown parser (`bodyHtml`) and shown beside the box, or in place of it where the form is narrow. The HTML is sanitized (links, images, tables and code blocks kept, nothing that runs), a component shows as its content, code is highlighted by the site's `markdown.highlight` (colours kept, nothing else of its markup), an image written as a path in the entry's folder (`./cat.png`, a PNG, JPEG, WebP, GIF or AVIF inside the collection's folder) is read by `GET /_kay/cms/markdown/image` and a link opens in a new tab. The page's own styles come from `form.previewClass`. A text kay cannot read, such as a component never closed, shows the reason in the pane. The route takes the guard of a save, so edit mode without a guard previews under `kay dev` only.
- In edit mode a click on a field that is a one-line `text` rendered as the whole text of its element (no attribute marker, no comment pair, no other marker or child element, so not a `textarea` or Markdown) sets `contenteditable="plaintext-only"` on it and types there: each `input` writes the draft as `textContent` with line breaks as spaces (an emptied optional text is unset, a nullable one `null`, a required one `''`), Enter keeps the text and ends the edit, Escape puts back the text from before, a click elsewhere ends it and a window blur does not, and the page swap leaves the focused element marked `data-kay-typing` alone, a button, summary, input or label never being made one; the schema's `maxLength`, `minLength` and `pattern` show under the text as an alert as it is typed (`aria-invalid`, `aria-describedby`), a marked element gets `tabindex="0"` in edit mode and Enter on it starts the edit, and an emptied optional text is unset when the edit ends, as the page would drop the element (`editor/inline.ts`). Any other field, a form still loading or a save holding the fields is brought up in the form as before.
- The editor's header has two toggles, both `aria-pressed`. Outline every field draws a dotted box over each marked field of the page, attributes and comment pairs included, in a layer of its own (`editor/marks.ts`, `.kcms-marks`, so the page's markup and CSS are untouched); it is off on a screen with a hover and on where `(hover: none)` matches (a phone), the choice kept in `localStorage` (`kcms-marks`). Whatever the toggle, the field under the pointer gets a dashed box and the one holding the keyboard focus a solid one; the toggle's default is not stored, only a click on it is. Browse puts `kcms-browsing` on `<html>` and turns the outlines, the tab stops and the click handling off, so links, menus and tabs work with the editor still open; the same button turns editing back on.
- A marked element is a tab stop with `aria-description="Edit <label>"` in edit mode (attribute markers and Markdown bodies included, a link, control or element with its own `tabindex` keeping its own), and a generic one (`div`, `span`, `p` and the like) holding only the text of one field, no attribute marker, Markdown body or child element, also gets `role="button"`, so Space acts as Enter there; the description is brought up to date on focus, once the form has loaded the field's label. All of it is removed when the editor closes or browses.
- An element carrying several fields (a text and an attribute) opens a `role="menu"` of their labels (`Title`, `Image (src)`) next to the click, or under the element for a key, instead of picking the first: arrows move, Escape closes and gives the focus back to the element, a click elsewhere closes it, and the chosen field is typed in or brought up in the form as a click on it alone would.
- A list the page renders carries `data-kay-list="<collection>:<slug>[@locale]:<path>"` on its element, each child being an item (the item's place is read from the fields marked inside it, else from its position when the list renders one child per item). In edit mode the item under the pointer or holding the focus gets a toolbar at its top right corner (Move up, Move down, Add after, Remove; a nested list's item stacks its toolbar above its parent item's; it stays while a form field is typed in, keeps inside the window's scrollbars and clear of the docked editor, and Tab reaches it after the item's last tab stop, then goes on past the item), an empty list gets an Add to at its start and is a tab stop (`role="group"`, Enter adds the first item), and the keyboard has Alt+Shift with ArrowUp or ArrowDown to move the item holding the focus, Delete or Backspace to remove it and Enter for a menu (Add before, Add after, Move, Remove), none of them while typing in place (`editor/page-lists.ts`, `page-list-tools.kay`). A blocks list asks which block type to add. The change is made in the entry's draft as the form's list makes it, so the form follows (its folded items too), `minItems` and `maxItems` disable Remove and Add, Remove shows Undo in the editor's status area and says so to screen readers, a move says `Moved {item} to {position} of {count}`, and no other change is made until the page shows the first one. The focus lands on the item that moved, took its place or was added; a new item whose first text is empty has no marker on the page (an empty text is not marked), so its input in the form takes the focus. A list inside a `data-kay-list` comment pair, an entry whose draft is not valid yet and the `lines` and `tags` kinds keep their form.
- A name reaches into a group with a dotted path, `address.street`, in `fields` (alone or in a row) and in `hide`: the field leaves its group and takes the place named, the group keeping the others (and vanishing once none is left). A path the schema lacks is warned of at boot like a missing name.
- A hidden field that a save refuses (a required one, say) still shows its issue above the form, so the editor is never told nothing. See [Fixing a refused save](#fixing-a-refused-save) for what the form does with the others.
- `list.columns` are field keys shown after the title, each headed by the field's label and sortable. A text, number, boolean (Yes or No), select (its label), date, image or file (its file name) or reference field can be a column; a list, group, JSON or custom field cannot.
- `list.actions` keeps some of a row's actions, `'move'`, `'publish'`, `'unpublish'`, `'duplicate'`, `'rename'`, `'editOnPage'`, `'delete'`; all by default. `actions: []` removes the Actions column.
- `group: 'Blog'` puts the collection under that heading in the content list (those with none come first) and `order: 1` places it (a number here, not the content config's `order` field name), the lowest first, then the site's order. `icon` takes an icon imported from `~icons/<prefix>/<name>`, drawn before the collection. The list names each collection's `description`, its drafts and scheduled entries, its last edit (a folder collection's last commit, when git knows one) and has a New entry button.
- A shape that means nothing, a name twice, a name both shown and hidden or an unknown action throws as `kay.config.ts` loads. A name the schema lacks logs a warning at boot, and the screens skip it.

### The list's behaviour

State is in the URL, so a view of the list is a link: `?q=` searches (accents and case ignored, in the title, the text fields, the cells and the body), `?status=draft|scheduled|published` filters a collection that has a draft or publish field, `?sort=<column>&dir=asc|desc` sorts and `?page=` pages. Sort, search and filter run on every entry of the collection, not on the page shown, and the count of results shows under the search once one is on. A header click sorts by that column (`title`, `locale`, `draft` for the status, `modified` and `author` of a folder collection, `cell:<field>` for a field's column). A sorted ordered collection shows no move buttons.

- A folder collection's list shows Last modified and Author columns, read from the repository's history in one `git log` (the last 5000 commits, 5 seconds at most; a file with no commit shows no date, as its modification time would only say when it was checked out), the day in the editor's zone and the page's language, and sortable across pages. A new entry has Cancel back to the list and Create and add another, which opens an empty form in the same locale.
- Ticking rows offers Publish, Unpublish and Delete on them (as many as `list.actions` keeps), one request each; the delete confirmation names the entries that refer to any of them. Duplicate saves a draft copy under `<slug>-copy`, `-copy-2`... and opens it; a collection with only a `publishAt` field dates the copy `9999-12-31` until an editor picks a date, so it does not go live at once, and an ordered collection numbers it after its last entry. A failed bulk row or duplicate toasts the server's reason (the first, for a bulk run).
- An empty collection offers New entry.

### Replacing a screen

A page of the app at a screen's path replaces it: `src/routes/admin/collections/shop/[...slug].kay` (under prefix `/` the screens mount in a `(admin)` group, a folder adding nothing to a URL, so the page is `src/routes/(admin)/collections/shop/[...slug].kay` and `src/routes/(admin)/_layout.kay` is the layout; a page outside the group keeps the app's layouts and guards) serves the shop's entries in place of `<prefix>/collections/[collection]/[...slug]`, and the other screens stay. A `src/routes/admin/_layout.kay` replaces the cms's own layout for every screen. That one holds the chrome (skip link, the settings' `logo` image and the name, nav with Content, Missing pages, Media and Unused uploads, a link back to the site), kayjs-ui's `Toaster` and `TooltipHost` and the stylesheet `@kaynooo/kayjs-cms/admin.css`, which imports Tailwind and kayjs-ui's theme, so a layout of your own renders the chrome and the toaster, imports the stylesheet and sets `export const page = { layouts: false, noindex: true }` to stay clear of the site's layouts as the default does. The extension's guard still runs before a replacing page, as guards resolve per URL directory across both trees, unless the app has a `_guard.ts` of its own at that level.

- `entryScreen({ collection, slug, locale })` gives `{ prefix, collection, entry }`. `entry` is `undefined` when the collection cannot be read (its `problem` says why) or holds no such entry. A page reading `?locale=` names it in `export const page = { query: s.Object({ locale: s.Optional(s.String()) }) }`.
- `collectionScreen(name)` gives `{ prefix, collection }`, for a new entry's screen, which has no entry to read.
- `listScreen({ collection, q, page, status, sort, dir })` gives `{ prefix, collection, rows, page, pages, total }`, the rows of a page of the list as the default list draws them, `cells` for the layout's columns included.
- The collection carries its layout as `collection.layout`, so the parts below need no other prop.

- A page of the app at a screen's path replaces it (under `src/routes/(admin)/` for prefix `/`, which keeps the cms's layout and guard), and `<prefix>/_layout.kay` of the app replaces the cms's layout (its own chrome with a nav and a link back to the site, `Toaster`, `TooltipHost`, `@kaynooo/kayjs-cms/admin.css`); the screens set `layouts: false` and `noindex: true`, so the site's header, footer, layout CSS and head tags never reach them, their titles end in `Content admin` (`cms.admin.brand`), and words `cms.admin.skip`, `cms.admin.navigation`, `cms.admin.viewSite` are new; the parts the screens are made of are exported: see [Arranging and replacing the screens](screens.md).

### The parts

- `createEntryForm({ prefix, collection, entry?, locale? })` (`entry` may be a function returning it, `() => all.entry` for a `persist` island that takes new props when the page refreshes in place, so `stored`, `name`, `subtitle` and `problem` follow it) is what the default screen runs: the drafts, the save (a new entry is created under the slug typed, then opened; Ctrl or Cmd+S saves while the screen is open), publish, unpublish, publish now, clear schedule, delete, reset, the leave guard, and the words the form reads. It returns `{ drafts, entry, collection, problem, shown, prefix, name, subtitle, slug, newLocale, suggestsSlug, typeSlug(), slugReport(), readSlugs(), saving, stranded, dirty(), canSave(), savedAt(), stored, isDraft(), scheduled(), save(), publish(), unpublish(), publishNow(), unschedule(), remove(), reset(), referrers(), askReferrers() }`; `publish()`, `unpublish()`, `publishNow()` and `unschedule()` save that one field and refuse over unsaved edits, putting the field back when the save is refused; `canSave()` is false with nothing to save or while saving; `askReferrers()`, which the delete confirmation runs as it opens (`ConfirmDelete`'s `onOpen`), sets `referrers()` to the `Collection: title` of the entries naming it in a reference field (`Collection (fr): title` for a localized one, not read inside a `json` field), asked from `GET /_kay/cms/referrers/<collection>?slugs=<JSON list>` so it is never older than the click and the screens scan nothing; `savedAt()` is `{ at, rebuilding, live? }` of the last save that went through, `live` once the entry's public page serves a save that waited for a rebuild; `stranded()` is `{ to, renamed }` once `remove()` deleted the entry (`to` the collection's screen) or `rename()` renamed it (`to` the entry under its new slug) but the leave was declined over edits not saved (the default screen then swaps its form for a notice linking `to`); `slug`, `newLocale` and `suggestsSlug` are signals, `entry` is the entry's reference (`{ collection, slug, locale }`).
- `entry-header.kay` (`prefix`, `collection`, `title`, `subtitle`; the crumbs from the content list through the collection, then the title; the `slot` is its actions), `entry-actions.kay` (the Draft badge, Edit on page, Publish or Unpublish, Publish now and Clear schedule for a scheduled entry, Delete, Reset, Save or Create, and where the entry stands), `entry-presence.kay` (`room`, `member`, from `entryPresence`, or `entryRoom(collection, entry, { name: '' })` from `@kaynooo/kayjs-cms/room` for the on-page editor, which shows it too: who else has this entry open, their names when `cms({ author })` gives them, else how many), `entry-identity.kay` (a new entry's slug and locale, nothing for a saved one: the slug is written from the title until typed in, `form.suggestsSlug`, `form.typeSlug(text)` and `form.slugReport()` driving it) and `entry-notices.kay` (a file that does not parse, a save refused with its Keep my edits after a conflict, issues on the entry, and issues on a field or the body that nothing on the screen renders).
- `entry-field.kay` (`form`, `name`) renders one field by its key in the schema, a group or a list with the fields inside it; a name the schema lacks throws, naming the schema's. `entry-body.kay` (`form`) renders the Markdown body. `entry-fields.kay` (`form`) renders all of them as the layout arranges them, notices first.
- `field-input.kay` (`drafts`, `entry`, `field`, `path`) renders any field at a dotted path, as a list item or a group's child; `file-input.kay` is an image or file field's control.
- A field the screen leaves out is not rendered, so a save that refuses it is shown in `EntryNotices`. Saves, conflicts (the fields both sides changed, Keep my edits, Take their version), uploads and issues are those of the default screen.
- `entry-editor.kay` (`prefix`, `collection`, `entry?`, `locale?`, `presence?` as `entryPresence(ctx, collection, entry)` from `@kaynooo/kayjs-cms/presence` returns it, for a server page) is the default entry form as one component, listing who else has the entry open when it is given `presence`, and `entry-table.kay` (`prefix`, `collection`, `rows`, `searched`) the default list, marking an entry `Being edited` (by name when the editors have one) through `entry-watch.kay` (`collection`, `entry`) for the first 50 rows, which watches through a room of its own that every editor is also listed in, so it is no editor to anyone, both usable as they are on a page of your own.
- No new text: the parts use the `cms.*` keys of [Texts and languages](words.md).

### Fixing a refused save

- A refused save puts the focus on the first field it marked invalid (`aria-invalid`, scrolled into view), or on the first notice above the form when it marked none, and a summary above the form lists every refused field as a link that focuses it (`#kcms-<collection>-<slug>-<locale>-f:<path>` ids, `b` for the body, `s` and `l` for a new entry's slug and locale). The summary is not announced itself, as each field's message is a live region. It lists every issue the entry has, so on the on-page editor those its preview finds as the editor types appear in it too. An issue on a field the screen does not draw stays a notice of its own, with no link.
- An edit answers its own field's issue and no other's: `drafts.set` drops the issues of its path, so the rest stand until their fields are edited or the next save or preview render names the issues anew. A render that names no issues, as a form's with no preview, leaves them be.
- A schema's `minLength`, `maxLength`, `pattern`, `minimum` and `maximum` are `minlength`, `maxlength`, `pattern`, `min` and `max` attributes of the control, and a required field's control (text, number, markdown, date, date and time, select) is `required`. The `pattern` attribute is set only for a pattern anchored at both ends (`^...$`) in one alternative and with no \p{...} or \u{...} escape and no astral character, which HTML and the schema read alike; any other is checked by the form alone. Once the editor leaves a box (the markdown editor too), its limits are checked as they type, worded as the server words them (`cms.check.*`); a limit the server judges differently (empty text, a pattern a `RegExp` cannot compile) is left to it, and the server stays the one that decides.
- A JSON box (a `json` field, or a custom kind with no editor) takes each text that parses as it is typed. One that does not keeps the last value, shows `{field} is not valid JSON` once left, and a save refuses without sending anything: Save stays enabled so pressing it says what to fix (`drafts.block(ref, path, message)`, `drafts.blocked(ref)`).
- A new entry's slug and locale show their own refusal, a taken slug included, as the other fields do; typing a new slug or picking a locale answers it (`drafts.dismissWhere(ref, match)`).
- A saved draft or scheduled entry with a page has a Share preview button, which copies a link for a week (`previewUrl` with `entry`, [Preview](../../../llms/content-cms.md)) showing that draft alone on its page to whoever has it, with no sign-in and no preview mode. It needs `preview` in kay.config.ts, and edits not saved yet disable it. With `cms({ roles })` it is a `publish` action. `POST /_kay/cms/entries/<collection>/<slug>/share` gives `{ link }`, or an issue for an entry with no page.
