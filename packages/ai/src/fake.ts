import type { AudioFormat, Finish, Piece, Provider, ProviderMessage, ProviderRequest, Reasoning, ToolSpec } from './types'
import process from 'node:process'
import { mediaChars } from './attachments'

// What a fake reply was asked: the request a provider would have been sent.
export interface Asked {
  // The name of the provider the ask was for: `fake`, or the one given to `ask({ provider })`, which the fake answers in its place under `bun test`.
  provider: string
  messages: ProviderMessage[]
  // The tools the model was offered, absent when it was offered none.
  tools?: ToolSpec[] | undefined
  system: string | undefined
  model: string
  maxTokens: number
  temperature: number | undefined
  reasoning?: Reasoning | undefined
  // The JSON Schema of the object the ask wants, absent when it asked for text.
  schema?: object | undefined
}

// A step of the model that calls tools, after the text it says first: a string `input` is sent as the arguments as they are, to see what a model garbling its JSON does.
export interface Calls {
  // What the model thinks before it answers, streamed as reasoning pieces ahead of the text and kept out of it.
  reasoning?: string | string[] | undefined
  text?: string | string[] | undefined
  // The object answering an ask with a `schema`, sent as its JSON text in pieces; any value, so a test can script one the schema refuses.
  data?: unknown
  calls?: { name: string, input?: unknown, id?: string | undefined }[] | undefined
  // Input tokens the step reports as read from the provider's prompt cache and written to it, on top of the ones it counts itself.
  cache?: { read?: number | undefined, written?: number | undefined } | undefined
  // Why the step ended, `stop` unless given, such as `length` for a reply cut by the token cap.
  finish?: Finish | undefined
}

type Scripted = string | string[] | Calls

export type Script = Scripted | ((asked: Asked) => Scripted)

// Tells whether a script is meant for an ask, by what it asked.
export type When = (asked: Asked) => boolean

interface Entry {
  script: Script | Error
  when: When | undefined
}

// A recording `transcribe()` was given.
export interface Heard {
  provider: string
  model: string
  audio: Blob
  language: string | undefined
}

// A text `speak()` was given.
export interface Spoken {
  provider: string
  model: string
  text: string
  voice: string | undefined
  speed: number | undefined
  format: AudioFormat | undefined
}

// The texts one `embed()` was given, a single text as a list of one.
export interface Embedded {
  provider: string
  model: string
  input: string[]
  dimensions: number | undefined
}

// What answers a call other than an ask: the value, an error it throws, or a function of what it was given.
export type FakeAnswer<Given, Value> = Value | Error | ((given: Given) => Value)

type OtherCall = 'transcribe' | 'speak' | 'embed'

interface Queued<Given, Value> {
  answer: FakeAnswer<Given, Value>
  when: ((given: Given) => boolean) | undefined
}

export interface Fake extends Provider {
  // Every ask the fake answered, oldest first.
  readonly asked: readonly Asked[]
  last: () => Asked | undefined
  // A provider that answers as the fake does, under the name and model of `provider`: what `ask({ provider })` is given under `bun test`.
  standIn: (provider: Provider) => Provider
  // The next ask read is answered with this (scripts go to asks in the order they are read, not made): a text, split into words, the pieces as they should come, or `{ text?, calls?, cache? }` to call tools or report cache reads and writes (a tool loop reads one script per step); a function reads what was asked. Scripts are used in order, then the default reply returns.
  // With `when`, the script is for the first ask `when` accepts, whatever asks were read before it, and the asks it does not accept never use it; the scripts without one keep going to the asks in order.
  reply: (script: Script, when?: When) => void
  // The next ask fails with this error, or the first one `when` accepts.
  fail: (error: Error, when?: When) => void
  // Every recording `transcribe()` was given, oldest first.
  readonly heard: readonly Heard[]
  // The next `transcribe()` returns this text, or throws this error; `Fake transcript` when none is left.
  transcript: (answer: FakeAnswer<Heard, string>, when?: (heard: Heard) => boolean) => void
  // Every text `speak()` was given, oldest first.
  readonly spoken: readonly Spoken[]
  // The next `speak()` returns this audio, or throws this error; a silent WAV as long as the text when none is left.
  speech: (answer: FakeAnswer<Spoken, Blob>, when?: (spoken: Spoken) => boolean) => void
  // Every `embed()` call, oldest first.
  readonly embedded: readonly Embedded[]
  // The next `embed()` returns these vectors, one per text, or throws this error; when none is left each text gets a stable vector from its words.
  embedding: (answer: FakeAnswer<Embedded, number[][]>, when?: (embedded: Embedded) => boolean) => void
  // Forgets what was asked and scripted.
  clear: () => void
}

const FAKE = Symbol.for('kayjs-ai.fake')
const WORDS = /\S+\s*|\s+/g
const CHARS_PER_TOKEN = 4
const DEV_PACE_MS = 20
const SAMPLE_RATE = 16_000
const MAX_SILENT_WORDS = 100
// The length of a fake vector when `embed` names none.
const DIMENSIONS = 256
const TOKENS = /[\p{L}\p{N}]+/gu

function pieces(text: string): string[] {
  return text.match(WORDS) ?? []
}

const SAMPLE_STRINGS: Record<string, string> = {
  'date-time': '2000-01-01T00:00:00.000Z',
  'date': '2000-01-01',
  'time': '00:00:00',
  'email': 'fake@example.com',
  'uri': 'https://example.com',
  'url': 'https://example.com',
  'uuid': '00000000-0000-4000-8000-000000000000',
}

type Node = Record<string, unknown>

// A value that fits a JSON Schema as far as it can be built from it, what an ask for an object gets from the fake when nothing is scripted: strings say `fake`, numbers sit at their minimum, a list has as many items as it needs.
function sampleOf(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null)
    return null

  const node = schema as Node

  if ('const' in node)
    return node.const

  if (Array.isArray(node.enum))
    return node.enum[0]

  if (Array.isArray(node.anyOf))
    return sampleOf(node.anyOf.find(member => (member as Node).type !== 'null') ?? node.anyOf[0])

  switch (Array.isArray(node.type) ? node.type[0] : node.type) {
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, unknown>
      const required = Array.isArray(node.required) ? node.required as string[] : []

      return Object.fromEntries(required.filter(name => name in properties).map(name => [name, sampleOf(properties[name])]))
    }
    case 'array':
      return Array.from({ length: typeof node.minItems === 'number' ? node.minItems : 0 }, () => sampleOf(node.items))
    case 'string': {
      const sample = typeof node.format === 'string' ? SAMPLE_STRINGS[node.format] : undefined
      const text = sample ?? 'fake'

      return typeof node.minLength === 'number' ? text.padEnd(node.minLength, '.') : text
    }
    case 'integer':
    case 'number': {
      const exclusive = typeof node.exclusiveMinimum === 'number' ? node.exclusiveMinimum + 1 : 0
      const low = typeof node.minimum === 'number' ? node.minimum : exclusive
      const high = typeof node.maximum === 'number' ? node.maximum : Infinity

      return Math.min(low, high)
    }
    case 'boolean':
      return false
    default:
      return null
  }
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.resolve()

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }

    timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

function tokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

// What a script has the model say: its text, or its data as JSON.
function saidBy(script: Scripted): string | string[] {
  if (typeof script !== 'object' || Array.isArray(script))
    return script

  return script.data === undefined ? script.text ?? [] : JSON.stringify(script.data, null, 2)
}

// The script for an ask: the first one whose `when` accepts it, else the oldest without a `when`.
function take(scripts: Entry[], question: Asked): Script | Error | undefined {
  const at = scripts.findIndex(entry => entry.when?.(question) === true)
  const found = at === -1 ? scripts.findIndex(entry => entry.when === undefined) : at

  return found === -1 ? undefined : scripts.splice(found, 1)[0]?.script
}

// The first answer `when` accepts, else the oldest without one, run on what was given.
function answerOf<Given, Value>(queue: Queued<Given, Value>[], given: Given, fallback: (given: Given) => Value): Value {
  const at = queue.findIndex(entry => entry.when?.(given) === true)
  const found = at === -1 ? queue.findIndex(entry => entry.when === undefined) : at
  const answer = found === -1 ? fallback : queue.splice(found, 1)[0]!.answer

  if (answer instanceof Error)
    throw answer

  return typeof answer === 'function' ? (answer as (given: Given) => Value)(given) : answer
}

// 16-bit mono PCM silence in a WAV, 0.3 s a word up to 30 s, so a test reading its length sees a longer text read for longer.
function silence(text: string): Blob {
  const samples = Math.min(MAX_SILENT_WORDS, Math.max(1, pieces(text.trim()).length)) * SAMPLE_RATE * 3 / 10
  const view = new DataView(new ArrayBuffer(44 + samples * 2))
  const ascii = (at: number, word: string) => {
    for (const [index, char] of [...word].entries()) {
      view.setUint8(at + index, char.charCodeAt(0))
    }
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)

  return new Blob([view.buffer], { type: 'audio/wav' })
}

// A unit vector from the words of a text, each hashed to one dimension: the same text always gets the same vector, and texts sharing words are near.
function vectorOf(text: string, dimensions: number): number[] {
  const vector = Array.from<number>({ length: dimensions }).fill(0)

  for (const word of text.toLowerCase().match(TOKENS) ?? []) {
    const hash = Bun.hash.crc32(word)

    vector[hash % dimensions]! += Math.floor(hash / dimensions) % 2 === 0 ? 1 : -1
  }

  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))

  if (length === 0)
    vector[0] = 1

  return length === 0 ? vector : vector.map(value => value / length)
}

function createFake(): Fake {
  const asked: Asked[] = []
  const scripts: Entry[] = []
  const heard: Heard[] = []
  const transcripts: Queued<Heard, string>[] = []
  const spoken: Spoken[] = []
  const speeches: Queued<Spoken, Blob>[] = []
  const embedded: Embedded[] = []
  const embeddings: Queued<Embedded, number[][]>[] = []

  // The calls other than an ask, answered under `provider`'s name; a stand-in offers only those of the provider it replaces, so one with no speech to text has none either.
  function calls(provider: string, has: (call: OtherCall) => boolean): Pick<Provider, OtherCall> {
    const all: Required<Pick<Provider, OtherCall>> = {
      transcribe: async ({ audio, model, language }) => Promise.try(() => {
        const given: Heard = { provider, model, audio, language }

        heard.push(given)

        return answerOf(transcripts, given, () => 'Fake transcript')
      }),
      speak: async ({ text, model, voice, speed, format }) => Promise.try(() => {
        const given: Spoken = { provider, model, text, voice, speed, format }

        spoken.push(given)

        return answerOf(speeches, given, () => silence(text))
      }),
      embed: async ({ input, model, dimensions }) => Promise.try(() => {
        const given: Embedded = { provider, model, input: [...input], dimensions }

        embedded.push(given)

        const vectors = answerOf(embeddings, given, () => input.map(text => vectorOf(text, dimensions ?? DIMENSIONS)))

        if (vectors.length !== input.length)
          throw new Error(`fakeAi.embedding() answered ${vectors.length} vectors for ${input.length} texts`)

        return vectors
      }),
    }

    return Object.fromEntries(Object.entries(all).filter(([call]) => has(call as OtherCall)))
  }

  const fake: Fake = {
    name: 'fake',
    model: 'fake',
    asked,
    last: () => asked.at(-1),
    standIn: provider => ({ name: provider.name, model: provider.model, accepts: provider.accepts, stream: (request, signal) => answer(request, signal, provider.name), ...calls(provider.name, call => provider[call] !== undefined) }),
    reply: (script, when) => void scripts.push({ script, when }),
    fail: (error, when) => void scripts.push({ script: error, when }),
    heard,
    transcript: (answer, when) => void transcripts.push({ answer, when }),
    spoken,
    speech: (answer, when) => void speeches.push({ answer, when }),
    embedded,
    embedding: (answer, when) => void embeddings.push({ answer, when }),
    clear: () => {
      for (const list of [asked, scripts, heard, transcripts, spoken, speeches, embedded, embeddings])
        list.length = 0
    },
    stream: (request, signal) => answer(request, signal, 'fake'),
    ...calls('fake', () => true),
  }

  async function* answer(request: ProviderRequest, signal: AbortSignal, provider: string): AsyncGenerator<Piece> {
    const question: Asked = { ...request, provider, messages: structuredClone(request.messages), tools: request.tools === undefined ? undefined : structuredClone(request.tools), schema: request.schema === undefined ? undefined : structuredClone(request.schema) }

    asked.push(question)

    const script = take(scripts, question) ?? (request.schema === undefined ? `Fake reply to: ${request.messages.findLast(message => message.role === 'user')?.content ?? ''}` : { data: sampleOf(request.schema) })

    if (script instanceof Error)
      throw script

    const chosen = typeof script === 'function' ? script(question) : script
    const calls = typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.calls ?? [] : []
    const cache = typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.cache : undefined
    const said = saidBy(chosen)
    const parts = typeof said === 'string' ? pieces(said) : said
    const pace = process.env.NODE_ENV === 'development' ? DEV_PACE_MS : 0
    const input = request.messages.reduce((sum, message) => sum + tokens(message.content) + Math.ceil(mediaChars(message) / CHARS_PER_TOKEN) + (message.results ?? []).reduce((all, result) => all + tokens(result.content), 0), 0) + tokens(request.system ?? '')

    const thoughts = typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.reasoning ?? [] : []

    yield { usage: { inputTokens: input, ...cache?.read === undefined ? {} : { cacheReadTokens: cache.read }, ...cache?.written === undefined ? {} : { cacheWriteTokens: cache.written } } }

    for (const reasoning of typeof thoughts === 'string' ? pieces(thoughts) : thoughts) {
      await pause(pace, signal)
      signal.throwIfAborted()

      yield { reasoning }
    }

    for (const text of parts) {
      await pause(pace, signal)
      signal.throwIfAborted()

      yield { text }
    }

    for (const [index, { name, input, id }] of calls.entries())
      yield { toolUse: { id: id ?? `fake_${index + 1}`, name, arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}) } }

    yield { usage: { outputTokens: tokens(parts.join('')) } }
    yield { finish: typeof chosen === 'object' && !Array.isArray(chosen) ? chosen.finish ?? 'stop' : 'stop' }
  }

  return fake
}

// Answers `ask` in development and under `bun test` instead of a provider, and a test scripts it and reads what was asked, as it reads kayjs-mail's `outbox`.
// Without a script it answers `Fake reply to: <the last user message>`.
export const fakeAi: Fake = ((globalThis as { [FAKE]?: Fake })[FAKE] ??= createFake())
