# Setup and saving files

Installing the cms, where a folder entry's file goes when an editor saves, and how a save stays safe from another editor's.

## Common tasks

### Install the cms

`kay add cms` installs the packages and adds `cms()` to `extensions`.

```ts
import { cms, forgejo } from '@kaynooo/kayjs-cms'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [cms({ guard: { load: async () => (await import('./src/auth')).auth.guard({ require: 'editor' }) }, files: forgejo({ baseUrl, repo: 'me/site', token }) })] })
```

### Commit saves to Forgejo

`forgejo({ baseUrl, repo, branch?, token, timeout?, fetch? })` commits each file through Forgejo's contents API.

```ts
cms({ guard, files: forgejo({ baseUrl: 'https://git.example.com', repo: 'me/site', token: env.FORGEJO_TOKEN }) })
```

### Write saves in the working tree

`workingTree()` writes or deletes the file in place, for `kay dev` or a server whose files outlive a deploy; a production server refuses to boot with it unless named.

```ts
cms({ guard, files: workingTree() })
```

### Write a saver of your own

A `FileSaver` checks `change.base` and throws `SaveConflictError` when the file is at another version, see [Renaming an entry's slug](rename.md) for `move`.

```ts
const saver: FileSaver = {
  async save(change) {
    if (change.base !== undefined && change.base !== (await versionOf(change))) throw new SaveConflictError(await versionOf(change))
    // write the file ...
    return undefined
  },
}
```

## Reference

- `cms({ prefix, logo, guard, files, uploads, pageSize, collections, rawHtml, author, onSave })`: `prefix` is where the screens live (`/admin`), `guard` who may use them and the API, as `{ load }` returning the guard, `files` where a folder entry's file goes (`workingTree()` by default, which a production server refuses to boot with unless named). Every option, the upload checks, `rawHtml` and `author` are in [Options of cms()](options.md).
- `forgejo({ baseUrl, repo, branch?, token, timeout?, fetch? })`: `baseUrl` must be https, or http on `localhost`, `127.x.x.x` or `[::1]`, else it throws, as the token travels in every request; commits each file through Forgejo's contents API, reading the file's sha first. Throws `ForgeError` with Forgejo's `status` and message, its first 200 characters (the log gets the rest), 504 when the save, its requests together, takes over `timeout` (a duration string, `'15s'`, a bare number throws; the read naming the version after a conflict has its own), or 502 naming why the forge could not be reached; one failing once the commit was sent says it may have gone through. The editor sees it as the save's issue, the log getting the whole error. Forgejo refusing the commit's sha (409, or 422 naming the sha) throws `SaveConflictError`.
- A save or a delete names the version of the file the editor opened, its git blob sha (`fileVersion(text)`): a saver finding the file at another, as after another editor's save, or one's own before the site rebuilt from it, throws `SaveConflictError` with the version it found as `current`. The editor keeps the refusal shown while the editor types, and its Keep my edits button takes that version as the one the edits were made from, so the next save writes them over it; nothing else is lost. A new entry must not exist yet. An app's own `FileSaver` checks `change.base` the same way, `null` meaning the file must not exist and `undefined` writing whatever is there; `workingTree()` checks and writes one save of a file at a time.
- The API refuses a save or a delete naming no version for a folder entry the server holds, as from an editor older than the server, logging it: reloading the page loads the editor that names it. A delete from the entry list names the version the list showed, and one from the editor after Keep my edits over a file deleted and made again since names none, so it is refused with a message telling the editor to reload rather than that it is older. Edits kept over a file deleted meanwhile are written as a new entry, refused if the file was made since.
- A loaded entry is versioned the same way with no help from the loader: its version is a hash of the `body` and the `data` fields the schema declares that the loader gave for it (`contentVersion`, key order ignored, so a loader adding or changing undeclared fields causes no conflict), which the editor names on a save or a delete, from the entry list too. A save or delete over an entry that has changed since, by another editor or by the app, is refused with `conflict` carrying the hash it is at now (`null` once deleted, which Keep my edits writes again as new), and a save answers the hash it left for the next one, so one editor saving twice never conflicts, nor does a stale save over a change that left the content as it was. The check reads the entry through the loader before the write, and the check, write and re-read of one collection's saves and deletes run one after the other in the server (not across servers); a loader giving a field that differs on every read conflicts on every save. A versioned save costs two more loader reads, a delete one.
- A file whose blob sha is not what `fileVersion` gives conflicts on every save: a repository checked out with CRLF line endings the server converts, or one using SHA-256 object names.
- Saving again while a save is on its way waits for it, then saves the edits typed meanwhile once.
- `workingTree()`: writes or deletes the file in place, for `kay dev`, or a server whose files outlive a deploy.
- A folder collection's source files ship with the server: kay throws for a folder missing from the build, and for one outside the repository. Slugs follow kay's rules, and a file that does not parse lists as broken, its form opening empty to write over it, a Markdown file keeping its body. A collection whose loader throws is listed as one that cannot be read, its error going to the server's log rather than the screens, which may name a database or its credentials.
