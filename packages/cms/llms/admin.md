# The admin screens

What each screen under `<prefix>` shows and does: the content list, an entry, a new entry, translations, media, unused uploads and the pages visitors did not find.

The screens fit a 375 px phone: no sideways scroll, lists stacked as cards, controls big enough to tap (covered in `tests/fixture/tests/site.test.ts`).

## Common tasks

### Order a collection by hand

A collection declaring `order: '<number field>'` lists its entries in that order with Up and Down on each.

```ts
collection(loader, { schema: s.Object({ title: s.String(), order: s.Number() }), order: 'order' })
```

### Schedule an entry

A collection declaring `publishAt: '<date field>'` shows a Status column and a Scheduled badge; the cms only edits the field, kay publishes the entry at that time.

```ts
collection(loader, { schema: s.Object({ title: s.String(), publishAt: s.Date() }), publishAt: 'publishAt' })
```

### Make a collection a single page

`single: true` makes the collection one entry (slug `index`), opened straight from the content list; `seed` fills its first form.

```ts
collection(loader, { schema: s.Object({ title: s.String() }), single: true, seed: { title: 'Home' } })
```

### Redirect a page visitors did not find

On `<prefix>/not-found` a row's Add redirect writes a redirect that answers at once; Dismiss hides the path and Gone answers a 410.

```ts
await fetch('/api/cms/redirects', { method: 'POST', body: JSON.stringify({ from: '/old', to: '/new', status: 308 }) })
```

## Reference

- `<prefix>`: each collection with its entry count.
- `<prefix>/collections/<collection>`: its entries, 50 a page, titled by their first one-line text field, searched, filtered and sorted from the URL, ticked for bulk actions, duplicated ([the list](screens.md#the-list)), with Publish for a draft, Edit on page for an entry kay knows the page of, and Delete. A collection declaring `publishAt: '<date field>'` (see Drafts in kay's content guide) has a Status column marking a published entry whose date is ahead, and the entry screen the same badge beside the form's date field, both in the editor's own zone (`Scheduled for 2026-10-20 10:00 GMT+2`, `UTC` until the browser says it) and gone when the date passes (`Published` in the list), with no reload; an editor sets, changes or clears the field; the cms only edits the field, kay publishes the entry at that time. A collection declaring `order: '<number field>'` lists its entries in that order with Up and Down on each (none while searching); a move writes the field of the two entries swapping places, or numbers the entries of that locale from 1 when their values repeat or are missing, each a save (`save` for a loaded collection), and stops at the first one refused.
- `<prefix>/collections/<collection>/<slug>` (`?locale=`): the entry's form, headed by its title under its crumbs (Content, then its collection), its slug beneath, and Save (disabled until something changed, also on Ctrl or Cmd+S), Reset, Publish or Unpublish, Delete and Edit on page beside it, with where the entry stands (Saving…, Unsaved changes, or Saved at the time, adding that the site shows it once it has rebuilt, with a link to the page, after a commit). The fields are locked while a save is on its way. Publish and Unpublish change the draft flag alone: with unsaved edits they refuse, and a refused save puts the flag back. A scheduled entry has Publish now and Clear schedule beside its badge; a collection declaring `unpublishAt: '<date field>'` shows `Ends <date>` beside the form while that date is ahead and `Ended` once it passes, with Clear end date beside it (the field itself is edited like any date). Delete names the entry and, for one with a page, warns that the page stops answering.
- A collection declaring `single: true` (and optionally `seed: { ... }`, see Collections in kay's content docs) is one entry: the content list links straight to its form, titled with the collection's `title`, with no slug field, New entry or Delete (the way back is the content list), `<prefix>/collections/<collection>` redirects to it, and `saveEntry` refuses a second entry and `deleteEntry` any delete. A new entry's form opens filled with the `seed`; its slug is `index`.
- `<prefix>/new/<collection>` (`?locale=`): a new entry, its slug and in a localized collection its locale, one the site serves. A folder collection's slug is written from the title until it is typed in (a checkbox turns that off), cleaned as typed (Latin accents dropped, other scripts kept with their marks (Greek accents, Arabic vowel signs), spaces and case: `Été à la ferme` is `ete-a-la-ferme`, `/` kept between folders; a title with no letter or digit says to type one), flagged and marked invalid as soon as the collection holds it, and says which folder it lands in, creates, or looks like a typo of (`GET /api/cms/slugs/:collection` lists the slugs). A loaded collection's slug stays as typed.
- `<prefix>/translations`: in a site with two locales or more, per localized collection the entries missing a locale or holding a text still as the default locale's (`title`, `summary` and the body; a field with a `format` or wrapped in `untranslated()` is left out). An entry's screen links its locales (a missing one starts a draft copy of it), `?compare=<locale>` shows another's text beside the form, a text equal to or empty beside the default locale's is said under its field, and the entries list flags the locales an entry lacks.
- `<prefix>/media`: the media library, every upload with its preview, size and the entries using it, renamed or deleted from there.
- `<prefix>/uploads`: the unused uploads, each with its variants and a Delete that asks first; ticked rows are deleted together, the content read once for all.
- `<prefix>/not-found`: the pages visitors asked for and found nothing at, most visited first, as the production server counted them (kay's `data/not-found.sqlite`), with the hosts they came from, the site's own pages that linked there (needs the request's `Host` to match the site's), the time of the last visit, a suggested target; paths a redirect answers are left out. Each row has Dismiss (it is listed again when asked for again; Clear the list and the selection do many), Gone (a 410) and an Add redirect button (a box offering the site's pages holding what is typed, `GET /api/cms/redirects/paths?q=`, when none is suggested), which writes the redirect (a 307, a 308 with its Permanent box ticked) to the file the running server reads (`addRuntimeRedirect` in `kay/library`, same-site targets only, loops and targets no page serves refused) so it answers at once and the path leaves the list, and a table of the redirects added here with Edit (the same path takes a new target or status), Remove and a selection, then the config's, read-only. They call `POST /api/cms/redirects` with `{ from, to, status? }` (307, 308, 410 or a kept 301 or 302, answering 400 with the refusal), `/remove` with `{ froms }`, `/dismiss` with `{ paths }` and `/clear`. Both need the app's `guard` and the same rules as the `redirects` of kay.config.ts: kay's llms/routing-endpoints-and-base.md, Redirects. Copying the `redirects` line into kay.config.ts stays possible.
- `<prefix>/page?path=`: opens the page in edit mode.
