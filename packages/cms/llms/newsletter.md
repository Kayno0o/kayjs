# Sending an entry to a mailing list

`cms({ newsletter })` names the collections whose entries an editor can mail to a [kayjs-mail mailing list](../../mail/llms/mailing-list.md), with the list and the mail an entry makes.

## Common tasks

- Mail a collection's entries: give `cms({ newsletter })` the collection, its `list` from `mail.list()` and a `message` turning the saved entry into the list mail.
- Let only publishers send: `roles` needs the `publish` action for the preview, the test and the send.
- Make the test reach the editor: nothing to give with kayjs-auth, whose signed-in user's email it is. Another address is `testTo` on the collection.

```ts
import { cms } from 'kayjs-cms'
import { mail } from './src/mail'
import Post from './src/mails/post.kay'

export default defineConfig({
  extensions: [cms({
    newsletter: {
      posts: { list: mail.list('news'), message: entry => ({ subject: String(entry.data?.title), view: Post, props: { entry } }) },
    },
  })],
})
```

## Reference

- `message(entry)` gets the saved entry (`slug`, `data`, `body`, `url`) and returns what `list.send` takes: `subject`, `view` and `props`, or `html` and `text`, plus `from` or `replyTo`. It may be async. It never sees an unsaved edit.
- The entry screen of such a collection has a Newsletter button, disabled with the reason while edits are unsaved or `roles` refuse. Its dialog shows the subject and the mail in a sandboxed frame, as the list would send it with the footer and an unsubscribe link that does nothing.
- Send me a test mails that one mail to the signed-in editor alone, subject `[Test] ...`. It goes to the `testTo` of the collection (an address, or a function of the guard context returning one, falling back to the person when it returns nothing), else to the email of the signed-in kayjs-auth user, else to the `email` of what `cms({ member })` reports; `cms({ author })`, the commit identity, is never used, so a pseudonym there decides nothing. With none of them (the password guard knows no email) it answers 400 and says to set `testTo`.
- Send to the list asks twice: the second click names the subscriber count. The mails are queued, paced and resumed by the list, as `list.send` does; a toast tells how many subscribers will get it.
- A draft, as the collection's `draft` says, can be previewed and tested but not sent (409). Sending one version of an entry again answers 409, also for a second request at once; saving the entry makes a new version, and a failed send can be tried again. A send is remembered in the app's `store.cache` for a year, so a restart or another process still refuses it; without a `store.cache` it is remembered in the process only, and a restart forgets it, so check the list's `status` for a send that matters.
- The routes are `POST /_kay/cms/newsletter/:collection/:slug/preview`, `test` and `send`, each taking `?locale=`. With `roles`, all three need `publish`.
- `cms({ newsletter })` throws a config error for an entry without a `list` from `mail.list()` or without a `message` function.
- The texts are the `cms.newsletter.*` messages ([Texts and languages: media to uploads](words-media-to-uploads.md)).
