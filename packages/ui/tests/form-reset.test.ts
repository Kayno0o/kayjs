import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, it } from 'bun:test'

type Reset = typeof import('../src/form-reset')

let reset: Reset

beforeAll(async () => {
  GlobalRegistrator.register()
  reset = await import('../src/form-reset')
})

afterAll(async () => GlobalRegistrator.unregister())

it('asks the controls through kui:hold-defaults, bubbling to the document with an object detail', () => {
  const form = document.createElement('form')
  const kept: string[] = []

  document.body.append(form)
  document.addEventListener('kui:hold-defaults', (event) => {
    const { adopt } = (event as CustomEvent<{ adopt: (() => void)[] }>).detail

    adopt.push(() => kept.push('control'))
  }, { once: true })
  reset.holdDefaults(form)()
  expect(kept).toEqual(['control'])
})
