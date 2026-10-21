# History and the trash

A collection read through a SQLite or Postgres loader keeps what an editor saved, the last 50 saves of each entry, which the editor lists, compares and restores, and what an editor deleted, for 30 days. It needs nothing declared, and `cms({ history: false })` turns it off, `cms({ collections: { notes: { history: false } } })` for one collection (no revisions, no trash, no buttons; what it kept stays in the store).

## Revisions

- Each save, publish, unpublish, duplicate and restore of a loaded entry keeps the data and body it wrote, who saved it (`cms({ author })`) and when, in a hidden collection beside the entry's own. The first save of an entry the history has never seen also keeps the entry as it stood before, as a version `Before the first saved change`. A save that changes nothing keeps nothing, and a reorder (`move`) is not a save.
- `cms({ history: { revisions: 100 } })` keeps another number per entry, the oldest going first. It takes a positive whole number or throws as `kay.config.ts` loads.
- The history is read at `<prefix>/history/<collection>/<slug>`, where an entry's screen has a History button: the versions newest first, each with who, when, how and the fields it changed from the version before (the old text struck, the new one beside it), the one the entry holds now marked Current, and a Restore on the others.
- Restore saves the older version again as a new version (`verb: 'restore'` in `onSave`): the schema, the version check and `cms({ roles })` apply as for any save. The editor's page names the entry's version, so a restore over a save made since is refused with the usual message. A role that may not `publish` restores with the draft flag and the publish and unpublish dates the entry has now, as a save of it would have to.
- Nothing else sees the history: it never shows in `all()`, a list, a count or a search, and a deleted entry's revisions stay.
- Only what the cms saved is kept: an edit made outside it, with `sqlite3` or by the app, is not a version, and shows as a change in the next save's diff.

## The trash

- Deleting a loaded entry (from its screen, the list or a bulk delete) keeps it first: its data, body, locale, who deleted it and when, in a hidden collection of the loader. The collection's list has a Trash button, opening `<prefix>/trash/<collection>`: the deleted entries newest first, each with a Restore.
- Restore writes the entry back under its slug and locale as a new entry (`verb: 'restore'` in `onSave`), so the schema applies and a slug made again since refuses it, the entry staying in the trash. It leaves the trash once restored, and its revisions are still there. A role that may not `publish` gets the entry back as a draft (held back by a far publish date in a collection with no draft flag), as it would a new entry.
- `cms({ history: { trash: '7d' } })` keeps them for another duration, `false` keeps none. What is older is dropped when the trash is read, with no timer, and the revisions of an entry never made again go with it. Turning the trash off leaves the rows already there untouched. A restored entry comes back without its old place in an ordered collection.
- A trash that cannot be written is logged and the delete goes on, so it cannot be undone. A delete the collection refuses keeps nothing, and the trash holds the entry as the loader gave it, so a restore after the schema changed may be refused for what it now requires.

## Which collections

- The history is written through the collection's own loader, into hidden collections of its store: `sqliteLoader` and `postgresLoader` keep them in the same table as the entries (under names no collection can have), so no table, setting or migration is added.
- A loader of your own gets history by giving `sibling(kind)`, which returns a loader for a hidden collection of that kind (`'history'`, `'trash'`) in the same store. Without it the collection keeps none, and its screens show no History button. Give the hidden loader a `get(place)` too, or each read of a revision loads the whole hidden collection.
- A folder collection keeps none: its files are in git, and the forge or the repository has their history.
- Every read and write is a `get` and a `save` of one row per entry; each revision is its own row beside an index row, so a save reads the index and the newest revision, then writes the new revision and the index, and a revision beyond the cap is removed.
