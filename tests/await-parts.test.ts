import type { PendingBlock } from '../src/runtime/await.server'
import type { ClientBuild } from '../src/server/client'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Await } from '../src/runtime/await.server'
import { readSnapshots } from '../src/runtime/snapshots'
import { pages, renderToString } from '../src/server'
import { PART_MS, streamDocument } from '../src/server/stream'
import { scratchDir } from './scratch'

const CLIENT: ClientBuild = { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: '' }
const decoder = new TextDecoder()

// The templates a streamed page sent for one block, each with what it held.
function templatesOf(page: string, id: string): string[] {
  return [...page.matchAll(new RegExp(`<template data-kay-await="${id}">(.*?)</template>`, 'g'))].map(match => match[1]!)
}

async function streamed(blocks: PendingBlock[], cancelAfter?: (chunk: string) => boolean): Promise<{ page: string, reported: unknown[] }> {
  const reported: unknown[] = []
  const reader = streamDocument('<html><body>', blocks, CLIENT, false, error => void reported.push(error)).getReader()
  let page = ''

  for (;;) {
    const { done, value } = await reader.read()

    if (done)
      break

    const chunk = decoder.decode(value)

    page += chunk

    if (cancelAfter?.(chunk)) {
      await reader.cancel()

      break
    }
  }

  return { page, reported }
}

function block(value: PendingBlock['value'], options: { failed?: boolean } = {}): PendingBlock {
  return { id: 'b', value, ready: (part: string) => ({ t: `<p>${part}</p>` }), failed: options.failed === true ? error => ({ t: `<p class="failed">${(error as Error).message}</p>` }) : undefined }
}

async function* parts(values: string[], gapMs: number, fail?: Error): AsyncGenerator<string> {
  for (const value of values) {
    await Bun.sleep(gapMs)
    yield value
  }

  if (fail)
    throw fail
}

describe('an await block given an async iterable', () => {
  it('sends each part as the whole block, keeping the markers until the last part, which goes out without them', async () => {
    const { page, reported } = await streamed([block(parts(['a', 'ab', 'abc'], PART_MS + 20))])

    expect(templatesOf(page, 'b')).toEqual(['<!--kay-await:b--><p>a</p><!--/kay-await:b-->', '<!--kay-await:b--><p>ab</p><!--/kay-await:b-->', '<!--kay-await:b--><p>abc</p><!--/kay-await:b-->', '<p>abc</p>'])
    expect(page).toEndWith('</body></html>')
    expect(reported).toEqual([])
  })

  it('sends the first part at once and only the latest of the parts that come faster than one per interval, always ending on the last', async () => {
    const many = Array.from({ length: 200 }, (_, index) => String(index))
    const { page } = await streamed([block(parts(many, 0))])
    const sent = templatesOf(page, 'b')

    expect(sent[0]).toBe('<!--kay-await:b--><p>0</p><!--/kay-await:b-->')
    expect(sent.length).toBeLessThan(20)
    expect(sent.at(-1)).toBe('<p>199</p>')
  })

  it('sends the latest part once the interval passes, without waiting for the next', async () => {
    async function* stalled(): AsyncGenerator<string> {
      yield 'a'
      yield 'ab'
      await Bun.sleep(PART_MS * 10)
      yield 'abc'
    }

    const started = Date.now()
    const times: number[] = []

    await streamed([block(stalled())], (chunk) => {
      if (chunk.includes('<p>ab</p>'))
        times.push(Date.now() - started)

      return false
    })

    expect(times).toHaveLength(1)
    // Well short of the stall, so a busy host still tells the two apart.
    expect(times[0]).toBeLessThan(PART_MS * 8)
  })

  it('reads a promise that is also an async iterable as a promise', async () => {
    const both = Object.assign(Promise.resolve('whole'), { async* [Symbol.asyncIterator]() {
      yield 'part'
    } })
    const { page } = await streamed([block(both)])

    expect(templatesOf(page, 'b')).toEqual(['<p>whole</p>'])
  })

  it('renders a value whose async iterator getter throws as a plain value', () => {
    const odd = Object.defineProperty({}, Symbol.asyncIterator, { get: () => {
      throw new Error('No getter')
    } })

    expect(Await({ value: odd, ready: () => ({ t: '<p>plain</p>' }) })).toEqual({ t: '<p>plain</p>' })
  })

  it('removes the pending block of an iterable that ends with no value', async () => {
    const { page, reported } = await streamed([block(parts([], 0))])

    expect(templatesOf(page, 'b')).toEqual([''])
    expect(reported).toEqual([])
  })

  it('renders the catch block of an iterable that throws before its first value or after it', async () => {
    const before = await streamed([block(parts([], 0, new Error('Down')), { failed: true })])
    const after = await streamed([block(parts(['a'], 0, new Error('Cut')), { failed: true })])

    expect(templatesOf(before.page, 'b')).toEqual(['<p class="failed">Down</p>'])
    expect(templatesOf(after.page, 'b')).toEqual(['<!--kay-await:b--><p>a</p><!--/kay-await:b-->', '<p class="failed">Cut</p>'])
    expect([...before.reported, ...after.reported]).toEqual([])
  })

  it('renders the catch block of an iterable failing to give its iterator, and still ends the page', async () => {
    const refusing = { [Symbol.asyncIterator]: () => {
      throw new Error('No iterator')
    } } as AsyncIterable<unknown>
    const { page, reported } = await streamed([block(refusing, { failed: true })])

    expect(templatesOf(page, 'b')).toEqual(['<p class="failed">No iterator</p>'])
    expect(page).toEndWith('</body></html>')
    expect(reported).toEqual([])
  })

  it('without a catch block, reports the failure, removing the pending block or leaving the parts sent so far', async () => {
    const before = await streamed([block(parts([], 0, new Error('Down')))])
    const after = await streamed([block(parts(['a'], 0, new Error('Cut')))])

    expect(templatesOf(before.page, 'b')).toEqual([''])
    expect(templatesOf(after.page, 'b')).toEqual(['<!--kay-await:b--><p>a</p><!--/kay-await:b-->'])
    expect([before.reported, after.reported].map(errors => (errors as Error[]).map(error => error.message))).toEqual([['Down'], ['Cut']])
  })

  it('stops reading an iterable whose then block throws, reporting it rather than showing the catch block', async () => {
    let returned = false

    async function* endless(): AsyncGenerator<string> {
      try {
        for (;;) {
          await Bun.sleep(5)
          yield 'x'
        }
      }
      finally {
        returned = true
      }
    }

    const broken: PendingBlock = { id: 'b', value: endless(), ready: () => {
      throw new Error('Bug')
    }, failed: () => ({ t: '<p class="failed">Shown</p>' }) }
    const { page, reported } = await streamed([broken])

    expect(templatesOf(page, 'b')).toEqual([''])
    expect((reported as Error[]).map(error => error.message)).toEqual(['Bug'])
    await Bun.sleep(20)
    expect(returned).toBe(true)
  })

  it('stops an iterable that never ends once the browser goes away', async () => {
    let returned = false

    async function* endless(): AsyncGenerator<string> {
      try {
        for (let index = 0; ; index++) {
          await Bun.sleep(5)
          yield String(index)
        }
      }
      finally {
        returned = true
      }
    }

    const { page } = await streamed([block(endless())], chunk => chunk.includes('data-kay-await'))

    expect(templatesOf(page, 'b')).toEqual(['<!--kay-await:b--><p>0</p><!--/kay-await:b-->'])
    await Bun.sleep(20)
    expect(returned).toBe(true)
  })
})

describe('reading the parts of an async iterable', () => {
  // An iterator noting each call, whose pending `next()` rejects once it is told to return, as one aborting a request does.
  function aborting(values: string[]): { source: AsyncIterable<string>, calls: string[] } {
    const calls: string[] = []
    let abort: ((error: Error) => void) | undefined

    return {
      calls,
      source: { [Symbol.asyncIterator]: () => ({
        next: async () => {
          calls.push('next')

          if (values.length > 0)
            return { value: values.shift()!, done: false }

          return new Promise<IteratorResult<string>>((_resolve, reject) => abort = reject)
        },
        return: async () => {
          calls.push('return')
          abort?.(new Error('Aborted'))

          return { value: undefined, done: true }
        },
      }) },
    }
  }

  it('ends with nothing once stopped, even when the pending next() then rejects', async () => {
    const { source } = aborting(['a'])
    const reader = readSnapshots(source, 0, () => undefined)

    await Bun.sleep(5)
    reader.stop()

    expect(await reader.done).toBeUndefined()
  })

  it('asks for no next part once what it showed stopped it', async () => {
    const { source, calls } = aborting(['a', 'b'])
    const reader = readSnapshots(source, 0, () => reader.stop())

    expect(await reader.done).toBeUndefined()
    expect(calls).toEqual(['next', 'return'])
  })
})

describe('an await block given an async iterable, on a page', () => {
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>

  beforeAll(async () => {
    dir = await scratchDir('await-parts-')
    await Promise.all([
      Bun.write(join(dir, 'routes/reply.kay'), `--- server
async function* reply() {
  for (const word of ['Hello', 'Hello there']) {
    await Bun.sleep(${PART_MS + 20})
    yield word
  }
}

async function* nested() {
  await Bun.sleep(5)
  yield 'first'
  await Bun.sleep(${PART_MS + 20})
  yield 'last'
}

const words = reply()
const outer = nested()
---
h1 Reply
// kay-allow uncaught-await
await words
  p.pending Thinking
then text
  p.text {text}
// kay-allow uncaught-await
await outer then part
  p.outer {part}
  // kay-allow uncaught-await
  await new Promise(resolve => setTimeout(resolve, 10, part.toUpperCase()))
    p.inner-pending Waiting
  then inner
    p.inner {inner}
`),
      Bun.write(join(dir, 'components/receipt.kay'), `---
async function* lines() {
  yield 'one'
  yield 'one, two'
}

async function* none() {}
---
// kay-allow uncaught-await
await lines() then text
  p {text}
// kay-allow uncaught-await
await none() then text
  p.none {text}
`),
    ])
    app = await pages({ routes: join(dir, 'routes'), prebuilt: false, security: false })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('sends the pending block at once, then the then block again with each part', async () => {
    const response = await app.handle(new Request('http://localhost/reply'))
    const chunks: string[] = []

    for await (const chunk of response.body!)
      chunks.push(decoder.decode(chunk))

    const page = chunks.join('')

    expect(chunks[0]).toContain('<p class="pending">Thinking</p>')
    expect(chunks[0]).not.toContain('Hello')
    expect(page).toContain('<p class="text">Hello</p><!--/kay-await:')
    expect(page).toMatch(/<template data-kay-await="\w+"><p class="text">Hello there<\/p><\/template>/)
  })

  it('shows the pending block of an await inside a part until the last part, whose block streams as any does', async () => {
    const page = await (await app.handle(new Request('http://localhost/reply'))).text()

    expect(page).toContain('<p class="outer">first</p><!--kay-await:')
    expect(page).toContain('<p class="inner-pending">Waiting</p>')
    expect(page).not.toContain('<p class="inner">FIRST</p>')
    expect(page).toContain('<p class="inner">LAST</p>')
  })

  it('renders the last part in place with renderToString, and nothing for an iterable with none', async () => {
    const { default: Receipt } = await import(join(dir, 'components/receipt.kay')) as { default: () => never }

    expect(await renderToString(Receipt)).toBe('<p>one, two</p>')
  })
})
