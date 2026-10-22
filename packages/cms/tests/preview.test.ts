import { afterEach, expect, mock, spyOn, test } from 'bun:test'

// What kay's build gives an API module's default export in the browser: where it is served.
void mock.module('../src/api/markdown', () => ({ default: { [Symbol.for('kay.api')]: '/_kay/cms/markdown' } }))

const { previewMarkdown } = await import('../src/editor/preview')

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.()
})

function answering(response: () => Response): { requests: { url: string, init?: RequestInit | undefined }[] } {
  const requests: { url: string, init?: RequestInit | undefined }[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })

    return response()
  }) as unknown as typeof fetch)

  return { requests }
}

test('posts the text and gives back the HTML', async () => {
  const { requests } = answering(() => Response.json({ html: '<p>Hi</p>' }))

  expect(await previewMarkdown('Hi')).toBe('<p>Hi</p>')
  expect(requests[0]?.url).toContain('/_kay/cms/markdown')
  expect(requests[0]?.init?.method).toBe('POST')
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ markdown: 'Hi' })
})

test('tells the route which entry the text is written for, once it has a slug', async () => {
  const { requests } = answering(() => Response.json({ html: '' }))

  await previewMarkdown('Hi', { collection: 'posts', slug: 'hello', locale: 'fr' })
  await previewMarkdown('Hi', { collection: 'posts', slug: '' })

  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ markdown: 'Hi', collection: 'posts', slug: 'hello', locale: 'fr' })
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ markdown: 'Hi' })
})

test('shows why a text kay cannot read is refused, escaped, and fails for any other error', async () => {
  answering(() => new Response('<Card> is never closed', { status: 422 }))

  expect(await previewMarkdown('<Card>')).toBe('<p>&lt;Card&gt; is never closed</p>')

  spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('down', { status: 500 })) as unknown as typeof fetch)

  await expect(previewMarkdown('x')).rejects.toThrow()
})
