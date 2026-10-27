import type { AiError, Reply } from '../src'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { files } from 'kay/server'
import { anthropic, ask, fakeAi, openai } from '../src'
import { anthropicEvents, openaiEvents, provider, stream } from './helpers/provider'

const servers: ReturnType<typeof provider>[] = []

function serve(handle: Parameters<typeof provider>[0]) {
  const server = provider(handle)

  servers.push(server)

  return server
}

afterAll(async () => {
  await Promise.all(servers.map(async server => server.stop()))
})

beforeEach(() => fakeAi.clear())

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3])
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3])
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n')
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

async function failure(reply: PromiseLike<unknown>): Promise<AiError> {
  try {
    await reply
  }
  catch (error) {
    return error as AiError
  }

  throw new Error('the reply did not fail')
}

describe('attachments to the fake', () => {
  it('records what each kind is, read from its bytes, in asked', async () => {
    const file = new File([PNG], 'shot.png', { type: 'image/png' })

    await ask([{ role: 'user', content: 'What is this?', attachments: [file, JPEG, PDF.buffer, new Blob([PDF])] }], { provider: fakeAi })

    const media = fakeAi.last()!.messages[0]!.attachments!

    expect(media.map(({ kind, type }) => [kind, type])).toEqual([['image', 'image/png'], ['image', 'image/jpeg'], ['pdf', 'application/pdf'], ['pdf', 'application/pdf']])
    expect(media[0]!.name).toBe('shot.png')
    expect(media[0]!.data).toEqual(PNG)
  })

  it('trusts the bytes, not the declared type or the name', async () => {
    const lie = new File([PDF], 'photo.png', { type: 'image/png' })

    await ask([{ role: 'user', content: 'x', attachments: [lie] }], { provider: fakeAi })

    expect(fakeAi.last()!.messages[0]!.attachments![0]!.kind).toBe('pdf')
  })

  it('reads a file of the store by its key', async () => {
    const key = await files.put(new File([PNG], 'stored.png', { type: 'image/png' }), { keepMetadata: true })

    await ask([{ role: 'user', content: 'x', attachments: [{ file: key }] }], { provider: fakeAi })

    expect(fakeAi.last()!.messages[0]!.attachments![0]!.type).toBe('image/png')
  })

  it('fails for a stored file that is gone', async () => {
    const error = await failure(ask([{ role: 'user', content: 'x', attachments: [{ file: 'photos/missing.png' }] }], { provider: fakeAi }))

    expect(error.kind).toBe('unsupported')
  })

  it('refuses a file that is no image or PDF a model is shown, before the provider', async () => {
    const error = await failure(ask([{ role: 'user', content: 'x', attachments: [new Blob(['hello'], { type: 'text/plain' })] }], { provider: fakeAi }))

    expect(error.kind).toBe('unsupported')
    expect(error.message).toContain('attachment 1 of message 1')
    expect(fakeAi.asked).toHaveLength(0)
  })

  it('refuses an attachment past maxAttachmentBytes, 10 MB by default', async () => {
    const big = new Uint8Array(1000)

    big.set(PNG)

    const error = await failure(ask([{ role: 'user', content: 'x', attachments: [big] }], { provider: fakeAi, maxAttachmentBytes: 999 }))

    expect(error.kind).toBe('too-long')
    expect(error.status).toBeUndefined()
    expect(fakeAi.asked).toHaveLength(0)
    expect(await ask([{ role: 'user', content: 'x', attachments: [big] }], { provider: fakeAi })).toBe('Fake reply to: x')
  })

  it('counts an image and a PDF against maxInputChars', async () => {
    const options = { provider: fakeAi }

    expect((await failure(ask([{ role: 'user', content: 'x', attachments: [PNG] }], { ...options, maxInputChars: 3999 }))).kind).toBe('too-long')
    expect(await ask([{ role: 'user', content: 'x', attachments: [PNG] }], { ...options, maxInputChars: 4001 })).toBe('Fake reply to: x')

    const pages = new Uint8Array(600 * 1024)

    pages.set(PDF)

    // 600 KB is three steps of 250 KB.
    expect((await failure(ask([{ role: 'user', content: 'x', attachments: [pages] }], { ...options, maxInputChars: 11_999 }))).kind).toBe('too-long')
    expect(await ask([{ role: 'user', content: 'x', attachments: [pages] }], { ...options, maxInputChars: 12_001 })).toBe('Fake reply to: x')
  })

  it('counts a stored file once it is read', async () => {
    const key = await files.put(new File([PNG], 'stored.png', { type: 'image/png' }), { keepMetadata: true })

    expect((await failure(ask([{ role: 'user', content: 'x', attachments: [{ file: key }] }], { provider: fakeAi, maxInputChars: 100 }))).kind).toBe('too-long')
  })

  it('takes only a user message to hold files, and only files', () => {
    expect(() => ask([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y', attachments: [PNG] }], { provider: fakeAi })).toThrow('only a user message')
    expect(() => ask([{ role: 'user', content: 'x', attachments: ['/etc/passwd' as never] }], { provider: fakeAi })).toThrow('an attachment is')
    expect(() => ask([{ role: 'user', content: 'x', attachments: 'nope' as never }], { provider: fakeAi })).toThrow('attachments are a list')
    expect(() => ask([{ role: 'user', content: 'x' }], { provider: fakeAi, maxAttachmentBytes: 0 })).toThrow('maxAttachmentBytes')
  })

  it('reads an object out of a scan with a schema', async () => {
    fakeAi.reply({ data: { total: 42 } })

    const bill = await ask([{ role: 'user', content: 'Read this bill', attachments: [new File([PDF], 'bill.pdf', { type: 'application/pdf' })] }], { provider: fakeAi, schema: s.Object({ total: s.Number() }) })

    expect(bill).toEqual({ total: 42 })
    expect(fakeAi.last()!.messages[0]!.attachments![0]!.name).toBe('bill.pdf')
    expect(fakeAi.last()!.schema).toBeDefined()
  })

  it('reports tokens for the files it was shown', async () => {
    const reply: Reply = ask([{ role: 'user', content: '', attachments: [PNG] }], { provider: fakeAi })

    expect((await reply.usage)!.inputTokens).toBe(1000)
  })
})

describe('attachments to a provider', () => {
  it('sends an image to an OpenAI-compatible server as a data URL beside the text', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)

    await ask([{ role: 'user', content: 'Describe', attachments: [JPEG] }, { role: 'assistant', content: 'A cat' }, { role: 'user', content: 'More' }], { provider: openai({ baseUrl: server.url, model: 'llava' }) })

    expect(server.seen[0]!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64(JPEG)}` } }, { type: 'text', text: 'Describe' }] },
      { role: 'assistant', content: 'A cat' },
      { role: 'user', content: 'More' },
    ])
  })

  it('sends a PDF as OpenAI\'s file part, or as Mistral\'s document_url', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)
    const named = new File([PDF], 'bill.pdf')

    await ask([{ role: 'user', content: 'Read', attachments: [named] }], { provider: openai({ baseUrl: server.url, model: 'm', pdf: 'file' }) })
    await ask([{ role: 'user', content: 'Read', attachments: [PDF] }], { provider: openai({ baseUrl: server.url, model: 'm', pdf: 'document_url' }) })

    const url = `data:application/pdf;base64,${base64(PDF)}`

    expect(server.seen[0]!.body.messages).toEqual([{ role: 'user', content: [{ type: 'file', file: { filename: 'bill.pdf', file_data: url } }, { type: 'text', text: 'Read' }] }])
    expect(server.seen[1]!.body.messages).toEqual([{ role: 'user', content: [{ type: 'document_url', document_url: url }, { type: 'text', text: 'Read' }] }])
  })

  it('fails a PDF for a server that is neither OpenAI nor Mistral, before calling it', async () => {
    const server = serve(() => stream(openaiEvents('ok')).response)
    const error = await failure(ask([{ role: 'user', content: 'Read', attachments: [PDF] }], { provider: openai({ baseUrl: server.url, model: 'llama' }) }))

    expect(error.kind).toBe('unsupported')
    expect(error.message).toContain('openai does not take a PDF')
    expect(server.seen).toEqual([])
  })

  it('sends images and PDFs to Anthropic as blocks before the text', async () => {
    const server = serve(() => stream(anthropicEvents('ok')).response)

    await ask([{ role: 'user', content: 'Compare', attachments: [PNG, PDF] }, { role: 'user', content: '', attachments: [JPEG] }], { provider: anthropic({ apiKey: 'k', baseUrl: server.url, model: 'claude' }) })

    expect(server.seen[0]!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64(PNG) } }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64(PDF) } }, { type: 'text', text: 'Compare' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64(JPEG) } }] },
    ])
  })

  it('shows a provider answering 400 for a model without vision as an invalid error', async () => {
    const server = serve(() => Response.json({ error: { message: 'this model does not support image input' } }, { status: 400 }))
    const error = await failure(ask([{ role: 'user', content: 'x', attachments: [PNG] }], { provider: openai({ baseUrl: server.url, model: 'text-only' }) }))

    expect(error.kind).toBe('invalid')
    expect(error.message).toContain('image input')
  })
})
