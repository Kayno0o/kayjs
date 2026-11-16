import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { stringify } from 'devalue'

let actionStub: typeof import('../src/runtime/action').actionStub
let FAILURE_HEADER: string

interface Reads {
  (input: object): Promise<{ ok: boolean }>
  pending: () => boolean
  status: () => string
  data: () => unknown
  failed: () => unknown
  error: (field?: string) => string | undefined
  form: { failed: () => { status: number, errors: Record<string, string> } | undefined, error: (field?: string) => string | undefined, validate: unknown }
  with: (fields: object) => Reads
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })
  ;({ actionStub } = await import('../src/runtime/action'))
  ;({ FAILURE_HEADER } = await import('../src/runtime/swap'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const mocks: { mockRestore: () => void }[] = []

afterEach(() => {
  for (const mock of mocks.splice(0))
    mock.mockRestore()
})

function answer(reply: () => Response | Promise<Response>): void {
  mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => reply()) as unknown as typeof fetch))
}

const stub = () => actionStub('/_kay/action/test/readers') as unknown as Reads
const refusal = (status: number, errors: Record<string, string>) => new Response(stringify({ errors, data: undefined }), { status, headers: { [FAILURE_HEADER]: '1' } })

describe('the readers a form shows, under form, in an island', () => {
  it('reads nothing before a call, and the call state stays on the action', () => {
    const add = stub()

    expect([add.form.failed(), add.form.error('title'), add.form.error()]).toEqual([undefined, undefined, undefined])
    expect([add.pending(), add.status(), add.data()]).toEqual([false, 'idle', undefined])
  })

  it('shows a refusal with field errors through form, the old names answering the same', async () => {
    answer(() => refusal(422, { 'title': 'Three letters at least', '': 'Not saved' }))

    const add = stub()

    expect((await add({})).ok).toBe(false)
    expect([add.form.error('title'), add.form.error(), add.form.failed()?.status, add.pending(), add.status()]).toEqual(['Three letters at least', 'Not saved', 422, false, 'failed'])
    expect([add.error('title'), add.failed()]).toEqual([add.form.error('title'), add.form.failed()])
  })

  it('clears the refusal while the next call is pending, and reads it through a with() action too', async () => {
    answer(() => refusal(422, { title: 'Taken' }))

    const add = stub().with({ id: 2 })

    await add({})
    expect(add.form.error('title')).toBe('Taken')

    const gate = Promise.withResolvers<void>()

    answer(async () => {
      await gate.promise

      return new Response(stringify({ id: 1 }))
    })

    const again = add({})

    expect([add.pending(), add.form.failed(), add.form.error('title')]).toEqual([true, undefined, undefined])
    gate.resolve()
    await again
    expect([add.pending(), add.status(), add.data(), add.form.failed()]).toEqual([false, 'ready', { id: 1 }, undefined])
  })
})
