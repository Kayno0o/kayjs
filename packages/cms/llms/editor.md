# The editor on the page

Content edited where it renders: in edit mode kay marks each element showing an entry's field, and the editor panel changes them with a live preview, with nothing for the app to write.

## Common tasks

### Enter edit mode

Edit mode is kay's preview mode, so the app sets `preview.secret`; a signed-in editor opens a page in it from `<prefix>/page?path=` or the Edit this page link, and leaves it with Stop editing.

```ts
export default defineConfig({ preview: { secret: env.PREVIEW_SECRET }, extensions: [cms({ guard, files })] })
```

### Make a field editable on the page

Render the entry's field as usual: kay marks the element itself in edit mode, so a click opens the field in the editor.

```kay
h1 {post.data.title}
img(src={post.data.photo} alt={post.data.title})
```

### Keep a fixed header clear of the panel

The panel pads the page's `body` by its width or height, and `html.kcms-editing` carries `--kcms-width` and `--kcms-height` for a site that wants to line up with the panel.

```css
html.kcms-editing .toolbar { right: var(--kcms-width, 0px) }
```

### Keep unsaved edits across a reload

The on-page editor keeps its drafts in `localStorage` with `browserKeeper()`; a site building its own editor passes it to `createDrafts`.

```ts
const drafts = createDrafts({ show, delay: '150ms', keep: browserKeeper() })
```

## Reference

- The app writes no marker: in edit mode kay marks each element rendering an entry's field itself, `data-kay-field="<collection>:<slug>[@<locale>]:<path>"`, each segment URI-encoded, the path dotted with list indexes (`sections.1.heading`). A field in an attribute is `data-kay-field-<attribute>`, a field sharing its element's text sits between `<!--kay-field …-->` and `<!--/kay-field-->`, fields are marked wherever the data is read, a component handed the entry's data included, and a Markdown body is `data-kay-body="<collection>:<slug>"` or a `kay-body` comment pair.
- The body's path is the `BODY` symbol, never a string, so a data field named `body` stays a data field.
- Outside edit mode the page is unchanged and the editor is not rendered.
- Above an entry's form the editor names the fields of it the page cannot let a click reach (`EditorProps.unclickable`): a transformed value, an island's props, a frozen object.
- The editor panel never covers what it edits: from 64rem it docks to the right and pads the page's `body` by its width, below that (and always below 40rem) it is a bottom sheet padding the `body` by its height, so the page keeps its width and a fixed header at the top stays in view (at the side the panel starts under a header fixed or sticky across the top, at most 240px tall and touching it, found by itself; one added later is found on the next scroll or resize). A visitor drags or arrow-keys its inner edge (a focusable `separator`) to resize it, switches the dock with the head's button (from 40rem), and hides it to a button; the dock, sizes and hidden state are kept in `localStorage` (`kcms-editor`). The dev tool docked at the right or bottom publishes `--kay-dev-inset-right` and `-bottom` on `html`, and the panel sits beside it, clamped so the page keeps 22rem (10rem tall); the open panel publishes what it holds as `--kay-panel-right` or `-bottom` on `html`, which the dev tool's bar and floating drawer keep out of (the collapsed button publishes itself the same way; the bar publishes its measured room at a bottom corner as `--kay-dev-bar-bottom-left` or `-right`). A click on a marked element scrolls it above the bottom sheet, and an entry's sticky header stays on one line. `html.kcms-editing` carries `--kcms-width` and `--kcms-height` for a site that wants to line up with the panel.
- Unsaved edits of the on-page editor are kept in `localStorage` (`kcms:draft:<entry>`, `browserKeeper()`, a week at most), cleared on save, Reset and Stop editing, and brought back after a reload, a crash or in a second tab with a note; a draft made from an older version of the entry (or, for an entry with no version, from another saved copy) is dropped with a note, never offered, and the write waits for the pause before the page renders again. A reload or a link with edits unsaved on the entries the page shows asks first (`guardLeave`), and Stop editing asks too: Keep editing or Drop them and stop. A conflict lists the fields both sides changed and offers Keep my edits or Take their version (`drafts.adopt`).
- Draft rendering happens on the server: the editor sends the changed entries, kay renders the page with them and swaps it in, islands kept. An entry the schema refuses shows its saved text while the others keep their preview, and the editor names it; a status line (`role="status"`) says `Updating the page…` while it renders, the drafts render again after in-app navigation, and for five minutes after a forge save (kept in `localStorage`) it says the live site may still show the old content, also after leaving edit mode and coming back.
- Every change goes through one API, `POST` and `DELETE /api/cms/entries/:collection/:slug` (and `GET`, which answers `{ collection, entry }` as the editor opens the entry, `?locale=` for a localized one, a 404 for a missing entry), `POST …/:slug/publish`, `POST …/:slug/duplicate` (a draft copy, answering its `slug`), `GET /api/cms/entries/:collection` (the entries a reference can pick, `[{ slug, title }]`) `POST …/:slug/move?direction=up|down` and `POST /api/cms/markdown` (`{ markdown }`, answering the sanitized `{ html }` of the editor's Preview, 422 for a text kay cannot read), from the sidebar and from the screens alike. kay validates the data against the schema and names the file; kay writes nothing, the configured `files` saver does.
- The app imports kayjs-ui's theme. The screens and the editor render their own `Toaster` and `TooltipHost`, which render nothing while the app's are mounted; kayjs-ui is a peer dependency, so both resolve the one copy that guard lives in.
- Edit mode is kay's preview mode, so the app sets `preview.secret`. An edit cookie or link reads through the API only the entries the pages it rendered in edit mode read (the editor's own entries; a signed-in editor the guard admits reads any), and leaves edit mode. It saves, publishes, deletes and uploads only under `kay dev` without a `guard`: with a `guard` every write needs it, and any other server without one (`NODE_ENV` unset included) refuses every write from an edit cookie or link and warns at boot, naming `cms({ guard })`, since the cookie is tied to no user. The scope is kept in memory per server, so after a restart, or on another replica, the page is loaded again before its editor reads; `editedEntry(request, collection, slug)` from `kay/server` is what the API reads it from.

### Dev tool

- `cms()` adds a CMS tab to the dev tool under `kay dev`, with nothing to add in the app: whether the visitor is in edit mode, a button into it for the page shown (through the screens' `page` route, so the guard decides) and one out of it (the `preview/exit` route). It reads `/_kay/cms`, a route mounted under `kay dev` alone.
