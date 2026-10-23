import { expect, test } from 'bun:test'
import { OWN } from '../src/editor/own'

test('the editor\'s own launcher is told apart from an app\'s SidePanel launcher', () => {
  const own = document.createElement('button')
  const app = document.createElement('button')

  own.dataset.part = 'launcher'
  own.setAttribute('aria-controls', 'kcms-editor')
  app.dataset.part = 'launcher'
  app.setAttribute('aria-controls', 'chat')

  const bare = document.createElement('button')

  bare.dataset.part = 'launcher'

  expect(own.matches(OWN)).toBe(true)
  expect(app.matches(OWN)).toBe(false)
  expect(bare.matches(OWN)).toBe(false)
})
