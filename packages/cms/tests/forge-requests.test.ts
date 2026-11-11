import type { FileChange, FileSaver } from '../src/files'
import { expect, spyOn, test } from 'bun:test'
import { errorMessage, forgejo } from '../src/files'
import { github } from '../src/github'
import { gitlab } from '../src/gitlab'
import { log } from '../src/log'

const change: FileChange = { repoPath: 'content/a.md', absolute: '/tmp/a.md', text: 'x', message: 'm' }

// Every request a saver makes, answered with a refusal so it stops after the first ones.
async function requestsOf(make: (fetch: typeof globalThis.fetch) => FileSaver): Promise<(RequestInit | undefined)[]> {
  const inits: (RequestInit | undefined)[] = []
  const saver = make((async (_url: unknown, init?: RequestInit) => {
    inits.push(init)

    return new Response('{"message":"no"}', { status: 500 })
  }) as typeof fetch)

  try {
    await saver.save(change)
  }
  catch {
    // the refusal ends the save; the requests it made are what is read
  }

  return inits
}

test('every forge request refuses a redirect, which would carry the token to another host', async () => {
  const forges = [
    (fetch: typeof globalThis.fetch) => forgejo({ baseUrl: 'https://git.example.com', repo: 'me/site', token: 't', fetch }),
    (fetch: typeof globalThis.fetch) => github({ repo: 'me/site', token: 't', fetch }),
    (fetch: typeof globalThis.fetch) => gitlab({ repo: 'me/site', token: 't', fetch }),
  ]

  for (const make of forges) {
    const inits = await requestsOf(make)

    expect(inits.length).toBeGreaterThan(0)
    expect(inits.every(init => init?.redirect === 'error')).toBe(true)
  }
})

test('words a refusal from the start of its body, and never reads the rest', async () => {
  const logged = spyOn(log, 'warn').mockImplementation(() => undefined)
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++
      controller.enqueue(new TextEncoder().encode('x'.repeat(16_384)))
    },
  })

  expect(await errorMessage(new Response(body, { status: 502 }))).toBe(`${'x'.repeat(200)}…`)
  expect(pulled).toBeLessThan(10)
  logged.mockRestore()
})
