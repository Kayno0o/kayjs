import { describe, expect, it } from 'bun:test'
import { answer, UnsupportedAnswerError } from '../src/server/answer'
import { RequestContext } from '../src/server/request-context'

function context(init: RequestInit = {}, path = '/thing'): RequestContext {
  return new RequestContext(new Request(`http://localhost${path}`, init), { method: 'GET', path, kind: 'api', options: {}, owner: 'test' }, {})
}

describe('answer', () => {
  it('passes a Response on as it is, compressed or not', async () => {
    const compressed = new Response(Bun.gzipSync('hello'), { headers: { 'content-encoding': 'gzip' } })
    const plain = new Response('hello')

    expect(answer(compressed, context())).toBe(compressed)
    expect(answer(plain, context())).toBe(plain)
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer())))).toBe('hello')
  })

  it('answers text, and nothing as 204', async () => {
    const text = answer('hi', context())
    const none = answer(undefined, context())

    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await text.text()).toBe('hi')
    expect(none.status).toBe(204)
    expect(none.body).toBeNull()
  })

  it('answers an object, an array, null, a number and a boolean as JSON', async () => {
    for (const value of [{ a: 1 }, [1, 'two'], null, 3, false]) {
      const response = answer(value, context())

      expect(response.headers.get('content-type')).toBe('application/json')
      expect(await response.json()).toEqual(value)
    }
  })

  it('writes a bigint as digits, and leaves a string that looks like the marker alone', async () => {
    const big = 12345678901234567890n
    const response = answer({ id: big, nested: [-5n], name: '__kay_bigint_x_1', text: `"${big}"` }, context())

    expect(await response.text()).toBe(`{"id":${big},"nested":[-5],"name":"__kay_bigint_x_1","text":"\\"${big}\\""}`)
    expect(await answer(7n, context()).text()).toBe('7')
  })

  it('answers a Blob as a file: Range, a range past the end and HEAD', async () => {
    const file = new Blob(['hello world'], { type: 'text/plain' })
    const whole = answer(file, context())
    const part = answer(file, context({ headers: { range: 'bytes=0-4' } }))
    const past = answer(file, context({ headers: { range: 'bytes=50-60' } }))
    const head = answer(file, context({ method: 'HEAD' }))

    expect(await whole.text()).toBe('hello world')
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('hello')
    expect(past.status).toBe(416)
    expect(head.headers.get('content-length')).toBe('11')
    expect(await head.text()).toBe('')
  })

  it('answers a Bun file and a stream, and bytes', async () => {
    const stream = answer(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('chunk'))
      controller.close()
    } }), context())

    expect(await stream.text()).toBe('chunk')
    expect(await answer(Bun.file(new URL('../package.json', import.meta.url).pathname), context()).json()).toHaveProperty('name')
    expect(await answer(new TextEncoder().encode('bytes'), context()).text()).toBe('bytes')
  })

  it('answers an async generator as an event stream', async () => {
    const response = answer((async function* () {
      yield 1
      yield { two: 2 }
    })(), context())

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toContain('data:')
  })

  it('gives a set status to a value, and leaves a Response its own', () => {
    const set = context()

    set.set.status = 201

    expect(answer({ a: 1 }, set).status).toBe(201)
    expect(answer(new Response('x', { status: 202 }), set).status).toBe(202)
  })

  it('fails a class instance, a Map and a function by naming the route', () => {
    class Note {}

    for (const value of [new Note(), new Map(), new Date(), () => undefined, Symbol('x')])
      expect(() => answer(value, context({}, '/notes'))).toThrow(UnsupportedAnswerError)

    expect(() => answer(new Map(), context())).toThrow('GET /thing returned Map')
    expect(() => answer(new Note(), context())).toThrow('returned Note')
  })
})
