# kayjs-ai: Images and PDFs

## Common tasks

### Show the model an image or a PDF

A user message holds `attachments` beside its text: a `File` or `Blob` (an `s.File()` field gives a `File`), bytes, or a file of kay's store:

```ts
import { ask, storedFile } from '@kaynooo/kayjs-ai'

ask([{ role: 'user', content: 'What is on this photo?', attachments: [photo] }])
ask([{ role: 'user', content: 'Summarize', attachments: [storedFile(key), new Uint8Array(bytes)] }])
```

### Read a bill into typed data

The scan goes with a `schema`, and `await` gives the checked object:

```kay
--- server
import { ask, storedFile } from '@kaynooo/kayjs-ai'
import { s } from 'kay'

const bill = s.Object({ supplier: s.String(), total: s.Number(), due: s.Optional(s.String()) })

export const read = action(s.Object({ scan: s.File({ type: 'application/pdf' }) }), async ({ scan }) => {
  return await ask([{ role: 'user', content: 'Read this bill', attachments: [scan] }], { schema: bill, maxAttachmentBytes: 5_000_000 })
}, { maxSize: '6mb' })
---
```

### Let a chat visitor attach a file

`Chat(action={reply} attach)` adds an attach button, drop and paste to the field, and the schema takes the files ([Chat](chat.md#attaching-files)).

- A button beside the field (its `attach` part, a plus, named `attachLabel`), dropping on it and pasting a file anywhere on the page outside a text field attach files, which show as chips with a remove button above the field and then in the visitor's turn. A message may hold files alone, posted with `content: ''`, so the schema's `content` takes an empty string (no `minLength`).
- `accept` (images and PDFs; an `accept` token matches as an `accept` attribute does, `image/*` and `.png` included, and a file the browser cannot type is taken and left to the action's 415), `maxFiles` (4 a message) and `maxFileSize` (5 MB each, in bytes) are the upload's checks, made before anything is sent; a file left out says why in a notice: `attachRefusedLabel`, `attachTooBigLabel` or `attachFullLabel`. Words: `ai.chat.attach`, `remove`, `attachRefused`, `attachTooBig` and `attachFull`; `@attachIcon` replaces the plus.
- The action still checks: `s.File({ type })` reads the bytes of a top-level field only, so for a file nested in `messages` `ask` reads them again and answers 415 for a file that is no image or PDF (`unsupported`), 413 past its `maxAttachmentBytes`. Take `maxSize` for `maxFiles` files of `maxFileSize` on the action.
- The files ride on the history: each send posts those of the `keep` latest messages again, so the model sees them in a follow-up, up to 8 MB for the messages before the last, the newest first (a message whose files do not fit leaves them all out, and goes itself, with the assistant reply that answered it, when it held nothing else; the last message keeps its files whatever they weigh), and a 413 shrinks the history counting each file as `ask` prices an image. The files live in the page: `remember` keeps the text of a turn, so after a reload the model no longer sees them.
- Stop's call to the server posts the last message without its files.

### Draft the alt of imported images

`ai({ imageAlt: true })` in `extensions` writes an `alt` on each `img` whose `src` is an imported image and that has none, on the pages `kay build` prerenders, and on a page rendered per request (`kay dev`, `prerender: false`, guarded pages) from the drafts already kept, drafting the missing ones in the background for the next render, and makes `kay check` skip `missing-alt` for those images.

- Each image is described once per locale (`page.locale`, in that language) by `describeImage(image, { language?, signal? })`, which you can call yourself: it asks with a `schema` for one short sentence and gives the trimmed text, empty for a decorative image (kept so it is not asked again, never written).
- The drafts live in `.kay/cache/libraries/kayjs-ai`, one file per image content and locale, so an unchanged image is never sent again; deleting the folder (and restarting a running server) drafts again. Only PNG, JPEG, GIF and WebP are sent: an AVIF or SVG keeps the lint's `alt` to write. A failing model logs once for that image, leaves it without an `alt` and is tried again ten minutes later; at most three images are described at once, by workers outside the visitor's request, so no visitor's limits are charged.
- An `alt` the author wrote, even `alt=""`, wins, and so do `aria-hidden="true"` and `role="presentation"` or `none`. An img inside an island is left to the `missing-alt` lint, as it renders in the browser.
- `kay check` lists each kept draft as a warning, read from the cache and never calling the model, with a warning more when `imageAlt` is on and no model is configured (development's fake is none). Under `bun test` the fake answers, so script it with `fakeAi.reply({ data: { alt } })`.
- Drafts count against the limits like any `ask`: in `kay build` there is no visitor, and a render that is refused keeps the img as it is.

## Reference

### What is accepted

- `attachments` is on a `user` message only (an `assistant` one fails with `unsupported`): a `Blob` or `File`, a `Uint8Array`, an `ArrayBuffer`, or `storedFile(key)` for a file `files.put` stored (never a key a visitor chose; a plain `{ file: key }` is refused).
- What a file is comes from its bytes, never its name or declared type, with kay's own check (`holdsType`): PNG, JPEG, GIF or WebP images and PDFs. Any other file, AVIF and SVG included, fails the reply with an `AiError` of kind `unsupported` naming the attachment (`attachment 2 of message 1`), before the provider is called; an action letting it out answers 415. A stored key with no file fails the same way.
- An attachment past `maxAttachmentBytes` (10 MB by default, a number of bytes) fails with `too-long` before the provider is called.
- They are read when the reply is first read, once however many steps a tool loop takes, so `ask()` itself stays synchronous and a bad file fails the reply like any error of it.

### Providers

- Anthropic gets `image` and `document` blocks, in base64 and before the text.
- An OpenAI-compatible server gets `image_url` parts with a data URL, before the text. A PDF is sent as OpenAI's `file` part at OpenAI itself, as Mistral's `document_url` part at `api.mistral.ai`, and a server of another kind takes images only: a PDF fails with `unsupported` naming `openai`, nothing sent. `openai({ pdf: 'file' | 'document_url' | false })` says how an OpenAI-compatible proxy takes PDFs.
- A model that cannot see images, or a server refusing the shape, answers 400 or 422, an `invalid` error carrying the server's words.
- A provider built by hand lists the kinds it takes in `accepts` (`['image']`, `['image', 'pdf']`), else both are taken; an ask holding another kind fails with `unsupported` before `stream` runs. Its `ProviderMessage`s carry `attachments` as `{ kind: 'image' | 'pdf', type, data: Uint8Array, name? }`.

### Limits

- `maxInputChars` counts an attachment as a price in characters, since a provider bills a file in tokens: an image 4,000 characters (about a thousand tokens, whatever its size), a PDF 4,000 for each 250 KB it holds. Before the files are read the estimate is from their size, a stored file counting as an image; once read, the exact price is checked again, so a PDF stored by key still fails `too-long` when it is over.
- The same price counts toward the budget's hold and a provider reporting no usage, so a visitor cannot spend unseen on files ([limits](limits.md)). The default 50,000 holds about twelve images, so an app reading scans raises `maxInputChars` with `maxAttachmentBytes`.
- Size the action too: a post sends 1 MB at most unless the action raises `maxSize` (kay's action protection), and a bound `s.Array(s.File(), { maxItems })` keeps a visitor from posting twenty.

### In tests

The fake records the files in `asked` as read, `fakeAi.last().messages[0].attachments` being `[{ kind: 'image', type: 'image/png', data, name: 'shot.png' }]`, and counts them in the tokens it reports.
