# Sending an entry to a mailing list

`cms({ newsletter })` names the collections whose entries an editor can mail to a [kayjs-mail mailing list](../../mail/llms/mailing-list.md), with the list and the mail an entry makes.

## Common tasks

- Mail a collection's entries: give `cms({ newsletter })` the collection, its `list` from `mail.list()` and a `message` turning the saved entry into the list mail.
- Let only publishers send: `roles` needs the `publish` action for the preview, the test and the send.
- Make the test reach the editor: give `cms({ author })`, whose `email` is where the test goes.

```ts
import { cms } from 'kayjs-cms'
import { mail } from './src/mail'
import Post from './src/mails/post.kay'

export default defineConfig({
  extensions: [cms({
    author: ({ locals }) => ({ name: locals.user.name, email: locals.user.email }),
    newsletter: {
      posts: { list: mail.list('news'), message: entry => ({ subject: String(entry.data.title), view: Post, props: { entry } }) },
    },
  })],
})
```

## Reference

- `message(entry)` gets the saved entry (`slug`, `data`, `body`, `url`) and returns what `list.send` takes: `subject`, `view` and `props`, or `html` and `text`, plus `from` or `replyTo`. It may be async. It never sees an unsaved edit.
- The entry screen of such a collection has a Newsletter button, disabled with the reason while edits are unsaved or `roles` refuse. Its dialog shows the subject and the mail in a sandboxed frame, as the list would send it with the footer and an unsubscribe link that does nothing.
- Send me a test mails that one mail to the signed-in editor alone, subject `[Test] ...`. Without `cms({ author })` it answers 400 and says so.
- Send to the list asks twice: the second click names the subscriber count. The mails are queued, paced and resumed by the list, as `list.send` does; a toast tells how many subscribers will get it.
- A draft can be previewed and tested but not sent (409). Sending one version of an entry again answers 409 in the same process; saving the entry makes a new version. A restart forgets the sends, so check the list's `status` for a send that matters.
- The routes are `POST /_kay/cms/newsletter/:collection/:slug/preview`, `test` and `send`, each taking `?locale=`. With `roles`, all three need `publish`.
- `cms({ newsletter })` throws a config error for an entry without a `list` from `mail.list()` or without a `message` function.
- The texts are the `cms.newsletter.*` messages ([Texts and languages: media to uploads](words-media-to-uploads.md)).
