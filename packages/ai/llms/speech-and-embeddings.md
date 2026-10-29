# kayjs-ai: Speech and embeddings

## Common tasks

### Write a recording down

```ts
import { transcribe } from '@kaynooo/kayjs-ai'

const text = await transcribe(recording, { language: 'fr' })
```

`transcribe(audio, options?)` takes a `Blob` or a `File` (an action's `s.File()`, a `Chat`'s recording) and returns the text, trimmed. `language` is an ISO 639-1 code; left out, the model tells, which a few words may get wrong. A `Chat` takes it through its `transcribe` action: [Speaking a message](chat.md#speaking-a-message).

### Read a text aloud

```ts
import { speak } from '@kaynooo/kayjs-ai'

const audio = await speak('Your table is booked for eight', { voice: 'nova', speed: 1.1, format: 'wav' })

return new Response(audio)
```

`speak(text, options?)` returns the audio as a `Blob` typed by its format, so `new Response(audio)` serves it with its `content-type`, `Bun.write(path, audio)` saves it and `await audio.bytes()` reads it. `voice` is `AI_VOICE` unless given, `speed` goes from 0.25 to 4 (another throws), `format` is `mp3`, `opus`, `aac`, `flac`, `wav` or `pcm`, the server's own (mp3 for OpenAI) unless given.

### Embed texts, store and search them

```ts
import { embed } from '@kaynooo/kayjs-ai'

const vector = await embed('How do I reset my password?', { dimensions: 768 })
const vectors = await embed(chunks.map(chunk => chunk.text), { dimensions: 768 })
```

`embed(text)` returns one vector (`number[]`), `embed(texts)` one per text in their order, in one request (an empty list sends none). `dimensions` is the length of each vector: sent as `dimensions` for a model that shortens its own (OpenAI's text-embedding-3, Ollama's nomic-embed-text), and a vector of another length fails the call with a `protocol` error, so a row never meets a column of another size. Pass the column's size every time.

pgvector through pg-orm keeps and searches them; the database needs the extension (`CREATE EXTENSION vector`, which the `pgvector/pgvector` image can give):

```ts
// src/db/passage.ts
import { embed } from '@kaynooo/kayjs-ai'
import { defineTable, embedding } from '@kaynooo/pg-orm'

export const Passage = defineTable('passage', f => ({
  id: f.serial().primaryKey(),
  text: f.text(),
  embedding: f.vector(768).nullable().index({ method: 'hnsw', opclass: 'vector_cosine_ops' }),
})).withTrait(embedding({ column: 'embedding', source: row => row.text, embed: texts => embed(texts, { dimensions: 768 }) }))
```

```ts
import { embed } from '@kaynooo/kayjs-ai'
import { db } from './db'
import { Passage } from './db/passage'

export async function store(texts: string[]) {
  await db.repo(Passage).write.insertMany(texts.map(text => ({ text })))
}

export async function nearest(question: string) {
  const vector = await embed(question, { dimensions: 768 })

  return db.repo(Passage).read.nearest(vector, { k: 5 })
}
```

The `embedding()` trait and `nearest()` need pg-orm 8. The trait embeds the `source` text of every insert, and of an update that changed it, in one `embed` call per write, and the column is `nullable` as it is filled just after the row. The trait also adds a nullable `embeddingHash` column, so the table needs a migration. `nearest()` returns the closest rows, each with its `distance`, cosine by default.

The passages found go to `ask({ sources })`, which a `Chat` cites: [Chat sources](chat-sources.md).

## Reference

### Environment

- `AI_AUDIO_URL`: the API root of an OpenAI-compatible server for `transcribe` and `speak` (OpenAI's `/audio/transcriptions` and `/audio/speech`), such as `http://localhost:8000/v1` for a local speaches or Kokoro server. Left out, they go to the server `ask` uses when it speaks OpenAI's API (`OPENAI_API_KEY` or `AI_BASE_URL`); Ollama has no audio and Anthropic neither, so an app on either sets it.
- `AI_EMBED_URL`: the same for `embed` (`/embeddings`). Ollama serves it, so an app on Ollama sets nothing; one asking Anthropic sets it, as Anthropic has no embeddings.
- `AI_TRANSCRIBE_MODEL` (`whisper-1`, `gpt-4o-transcribe`), `AI_SPEECH_MODEL` (`gpt-4o-mini-tts`, `tts-1`), `AI_EMBED_MODEL` (`text-embedding-3-small`, `nomic-embed-text`): the model of each call, `{ model }` overriding it. None is built in: a call with neither throws a `config-invalid` error naming the variable.
- `AI_VOICE`: the voice `speak` reads in unless it names one; with neither, none is sent and the server picks (OpenAI refuses that).
- `AI_AUDIO_KEY` and `AI_EMBED_KEY`: the bearer of the `AI_AUDIO_URL` and `AI_EMBED_URL` servers. Without one, `OPENAI_API_KEY` is sent only when that server shares the origin of the one `ask` uses (`AI_BASE_URL`, else OpenAI), so the key of one host never goes to another. A local server wanting none sets neither. `ai()` lists them all in `kay env`, none required.
- Under `bun test` the fake answers whatever is set, and in development until a server is configured; in production a call with none throws, naming what to set.

### Options and errors

- All three take `model`, `signal`, `timeout` (a duration for the whole call, `'2m'` by default, as a local Whisper loads its model on the first one) and `provider`, one built by hand such as `openai({ baseUrl })`, whose `transcribe`, `speak` and `embed` methods they call; `anthropic()` has none, an `unsupported` error. With `provider` the variables are not read, as with `ask`: pass `model` (and `voice`). Under `bun test` the fake answers in its place, `provider` its name.
- A call stops when the request being answered aborts, or when `signal` does.
- Errors are `AiError`s of the kinds `ask` throws ([errors](testing-and-errors.md#errors)): `auth`, `rate-limited`, `unavailable`, `invalid` (an unknown model, a file the server cannot read), `network`, `timeout` and `protocol` (an answer of no shape the API gives), the key hidden from what a server echoes.
- A `Blob` recording is uploaded under a name from its type (`audio.webm`, `audio.m4a`, `audio.mp3`), as OpenAI tells the format by it; a `File` keeps its own.
- None counts against `ai({ rateLimit, budget })`, which count asks and their tokens, nor shows in the dev tool's AI tab: rate limit the action calling one with `protect.rateLimit`.

### The fake

- `transcribe` answers `Fake transcript`, `speak` a silent 16 kHz WAV, 0.3 s a word, typed `audio/wav` whatever the `format`, and `embed` a unit vector of `dimensions` numbers (256 unless given) from the words of each text: the same text always gets the same vector, and texts sharing words are nearer than texts sharing none, so a search test ranks roughly as a model would.
- `aiTest()` scripts them: `model.transcript(text)`, `model.speech(blob)` and `model.embedding(vectors)` answer the next call, an `Error` makes it throw, a function of what was given answers it, and a second argument `when` picks the call it is for. `model.heard` (`{ provider, model, audio, language }`), `model.spoken` (`{ provider, model, text, voice, speed, format }`) and `model.embedded` (`{ provider, model, input, dimensions }`, `input` a list even for one text) keep every call; all are cleared between tests, as asks are.

```ts
import { speak, transcribe } from '@kaynooo/kayjs-ai'
import { aiTest } from '@kaynooo/kayjs-ai/test'
import { expect, it } from 'bun:test'

const model = aiTest()

it('reads back what was said', async () => {
  model.transcript('Book a table for two')

  await speak(await transcribe(new File(['x'], 'recording.webm')), { voice: 'nova' })

  expect(model.spoken.at(-1)).toMatchObject({ text: 'Book a table for two', voice: 'nova' })
})
```
