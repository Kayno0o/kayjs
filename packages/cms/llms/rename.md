# Renaming an entry's slug

Changing the slug of an entry from the editor, what follows from it (the entries naming it, the old URL) and what a saver does to support it.

## Common tasks

### Rename an entry

The entry editor's Rename button, or the Rename row action of the entries list, asks for a new slug and opens the entry under it; the entries naming it follow and the old page redirects to the new one by itself. The editor calls `POST /api/cms/entries/:collection/:slug/rename` with `{ slug }`.

```ts
await fetch(`/api/cms/entries/posts/hello/rename?version=${version}`, { method: 'POST', body: JSON.stringify({ slug: 'hello-world' }) })
```

### Keep translations paired through a rename

A localized entry paired with its translations by its slug gets `translationKey: <old slug>` when its schema has a `translationKey` field, so set the field before renaming one locale's slug.

```ts
s.Object({ title: s.String(), translationKey: s.Optional(s.String()) })
```

### Let your own saver rename

A `FileSaver` renames a folder entry's file with `move(move)`; without it the saver cannot rename entries.

```ts
import type { FileSaver } from '@kaynooo/kayjs-cms'

const saver: FileSaver = {
  async save(change) { /* ... */ },
  async move(move) {
    await write(move.to.absolute, move.text)
    await remove(move.from.absolute)
  },
}
```

## Reference

### Savers

A `FileSaver` may have `move(move)`, which renames a folder entry's file: `move.from` and `move.to` each hold `repoPath` and `absolute`, `move.text` is the text the file has at `to`, `move.base` the version of `from` (as `change.base` for a save), and `move.message` and `move.author` as in a save. It writes `to` then removes `from` (in one commit on Forgejo) and throws `SaveConflictError` when `from` is at another version or gone (`current` is its version, `null` once gone), or when `to` exists (`new SaveConflictError(undefined, true)`). `forgejo()` commits the move as one commit (a delete and a create, which git reads as a rename) and `workingTree()` does it in place. `move.also` holds other files changed in the same commit (`repoPath`, `absolute`, `text` and `base` as a save's change), the entries that named the renamed one: one at another version than its `base` makes the move throw `new SaveConflictError(current, false, repoPath)` having written nothing. A saver says it commits them with `together: true` (`forgejo()` and `workingTree()` do); without it they are saved one by one with `save` after the move. A saver without `move` cannot rename entries.

### Renaming

The entry editor's Rename button (off for a collection of one entry and while the form has unsaved edits), and the Rename row action of the entries list (`list.actions` keeps it by default), ask for a new slug, cleaned as it is typed (Rename is off, with the reason beside the field, for a taken slug; a new folder is announced; the entries naming this one are listed; a refusal shows in the dialog), and opens the entry under it. It calls `POST /api/cms/entries/:collection/:slug/rename` with `{ slug }`, `?locale=` and the `?version=` the editor showed, which the server requires, and the store's `renameEntry(ref, slug, { author, version, required })`: a folder entry's file is moved through the saver, keeping its format and body, and a loaded entry is saved under the new slug and removed from the old, never going to the trash, its history moving with it. A `slug` field in the entry's data is set to the new slug. It is refused, writing nothing, for a new slug that is taken or names another place (`..`, a slash or a hidden part), a collection of one entry, a saver without `move`, an entry naming it that cannot be saved (from a folder outside the repository, or whose version cannot be read), a collection that could hold entries naming it and fails to read (so no reference is left dangling), and a `version` that is not the entry's. `onSave` gets the verb `rename`, `slug` the new one and `from` the old. `unique` fields do not count the entry's own values as taken by its old slug.

### The entries naming it

`renameEntry` points every entry that names the renamed one in a `reference` field at the new slug, in lists, groups and blocks, with no declaration from the app. The entries are read again just before, each with its version. A localized collection's entry follows in its own locale only, and an entry with no locale (a non-localized collection's) follows only while no other locale holds the old slug. Folder entries go in the move's commit (`together` savers); the rest, loaded ones and those of a saver that does not commit together, are saved with `saveEntry` afterwards, so they get a history revision, `onSave` with the verb `update`, and their own version check. One of them that cannot be saved is named in the outcome's `unpointed` (`Collection: title`) and the editor toasts it; the rename stands. An entry referring to the renamed one itself follows too.

A localized entry paired with its translations by its slug gets `translationKey: <old slug>` when its schema has a `translationKey` field, so renaming one locale keeps them paired.

### The old URL

The page the entry had, per locale (`url` as `entries()` gives it), redirects to the page it has now, by itself and with nothing in `kay.config.ts`: the redirect joins the set an editor adds on the Not found screen (307, which an editor can make permanent there), kept in `data/not-found.sqlite`, so it survives a restart, and it answers only where the old path finds nothing. The base and `trailingSlash` are the site's, as for any redirect. Another rename moves every redirect that led to the old page to the new one, so a chain is one hop, and a rename back to an earlier slug removes the redirect from the page that exists again, so there is no loop. An entry with no page of its own, or a page on another locale's domain, gets none. A redirect the set refuses (a path of `kay.config.ts`'s redirects, say) is logged and the rename stays. Translations of a localized entry pair by `translationKey` or, without one, by the slug: set `translationKey` before renaming one locale's slug.
