import type { AudioFormat, EmbedRequest, SpeakRequest, TranscribeRequest } from './types'
import { AiError } from './errors'
import { exchange } from './http'

const FORMAT_TYPES: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

const EXTENSIONS: Record<string, string> = { 'mpeg': 'mp3', 'x-wav': 'wav', 'wave': 'wav', 'x-m4a': 'm4a', 'mp4': 'm4a', 'x-flac': 'flac' }
const SUBTYPE = /^(?:audio|video)\/([\w.-]+)/

// The name a recording is uploaded under: OpenAI tells the format by its extension, so a bare Blob gets one from its type.
function fileName(audio: Blob): string {
  if (audio instanceof File && audio.name !== '')
    return audio.name

  const subtype = SUBTYPE.exec(audio.type)?.[1]

  return subtype === undefined ? 'audio' : `audio.${EXTENSIONS[subtype] ?? subtype}`
}

// The JSON object of an answer, or a protocol error naming what came instead.
async function objectOf(name: string, response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()

  try {
    const value: unknown = JSON.parse(text)

    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>
  }
  catch {}

  throw new AiError('protocol', `${name} answered something that is no JSON object: ${text.slice(0, 80)}`)
}

// The OpenAI audio and embeddings endpoints of the server at `root`, which `openai()` gives its provider.
export function openaiCalls(root: string, apiKey: string | undefined) {
  const auth: Record<string, string> = apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }

  return {
    async transcribe({ audio, model, language, timeout }: TranscribeRequest, signal: AbortSignal): Promise<string> {
      const form = new FormData()

      form.append('file', audio, fileName(audio))
      form.append('model', model)
      form.append('response_format', 'json')

      if (language !== undefined)
        form.append('language', language)

      return exchange('openai', `${root}/audio/transcriptions`, { headers: auth, body: form }, timeout, signal, async (response) => {
        // A server ignoring `response_format` answers the text alone.
        if (!(response.headers.get('content-type') ?? '').includes('json'))
          return (await response.text()).trim()

        const { text } = await objectOf('openai', response)

        if (typeof text !== 'string')
          throw new AiError('protocol', 'openai answered a transcription with no text')

        return text.trim()
      }, apiKey)
    },
    async speak({ text, model, voice, speed, format, timeout }: SpeakRequest, signal: AbortSignal): Promise<Blob> {
      const body = { model, input: text, ...voice === undefined ? {} : { voice }, ...speed === undefined ? {} : { speed }, ...format === undefined ? {} : { response_format: format } }

      return exchange('openai', `${root}/audio/speech`, { headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeout, signal, async (response) => {
        const type = response.headers.get('content-type') ?? ''

        if (type.includes('json'))
          throw new AiError('protocol', 'openai answered JSON, not audio')

        // A server naming no audio type leaves the format asked, or OpenAI's mp3, to say what it is.
        return new Blob([await response.bytes()], { type: type === '' || type.startsWith('application/octet-stream') ? FORMAT_TYPES[format ?? 'mp3'] : type })
      }, apiKey)
    },
    async embed({ input, model, dimensions, timeout }: EmbedRequest, signal: AbortSignal): Promise<number[][]> {
      const body = { model, input, ...dimensions === undefined ? {} : { dimensions } }

      return exchange('openai', `${root}/embeddings`, { headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeout, signal, async (response) => {
        const { data } = await objectOf('openai', response)
        const items = Array.isArray(data) ? data as { index?: unknown, embedding?: unknown }[] : []
        const vectors: number[][] = []

        for (const [at, item] of items.entries()) {
          const index = typeof item.index === 'number' ? item.index : at

          if (!Array.isArray(item.embedding) || !item.embedding.every(value => typeof value === 'number'))
            throw new AiError('protocol', `openai answered no list of numbers for the text at ${index}`)

          vectors[index] = item.embedding
        }

        if (vectors.length !== input.length || input.some((_, at) => vectors[at] === undefined))
          throw new AiError('protocol', `openai answered ${items.length} vectors for ${input.length} texts`)

        const wrong = dimensions === undefined ? undefined : vectors.find(vector => vector.length !== dimensions)

        // A model ignoring `dimensions` would fill a vector column of another size with rows it refuses.
        if (wrong !== undefined)
          throw new AiError('protocol', `openai answered vectors of ${wrong.length} numbers, not the ${dimensions} asked: the model ${model} does not take \`dimensions\``)

        return vectors
      }, apiKey)
    },
  }
}
