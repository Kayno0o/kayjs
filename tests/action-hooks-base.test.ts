import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, it } from 'bun:test'

let actionStub: typeof import('../src/runtime/action').actionStub
let reactive: typeof import('../src/runtime/reactive')

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/app/page' })
  document.head.innerHTML = '<meta name="kay-base" content="/app">'
  reactive = await import('../src/runtime/reactive')
  ;({ actionStub } = await import('../src/runtime/action'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

it('matches the action the form names without the base, as the form fires it, under a base', () => {
  const seen: string[] = []
  const dispose = reactive.root((end) => {
    const add = actionStub('/app/_kay/action/test/base') as unknown as { onStart: (listener: () => void) => () => void }

    add.onStart(() => seen.push('start'))

    return end
  })
  const fire = (action: string) => document.dispatchEvent(new CustomEvent('kay:action-start', { detail: { action, data: new FormData() } }))

  fire('/_kay/action/test/base')
  fire('/app/_kay/action/test/base')
  fire('/_kay/action/test/other')
  expect(seen).toEqual(['start'])
  dispose()
})
