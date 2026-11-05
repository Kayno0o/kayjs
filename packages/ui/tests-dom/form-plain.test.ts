import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import FormPlain from '../tests/fixture/src/components/form-plain.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

const message = (root: HTMLElement) => root.querySelector('[data-field="title"]')!.textContent

test('a FormField of a form(action) in a component shows add.error(name) with no Form and no issue prop, and clears it once a call goes through', async () => {
  let refuse: string | undefined = 'Too short'

  mounted = await mountComponent(FormPlain, { call: async (input: { title: string }) => refuse === undefined ? input.title : { errors: { title: refuse } } })

  const { root } = mounted

  expect(message(root)).toBe('')
  click(root.querySelector('#submit'))
  await settle()
  expect(message(root)).toBe('Too short')

  refuse = undefined
  click(root.querySelector('#submit'))
  await settle()
  expect(message(root)).toBe('')
})

test('shows a message that is markup as text', async () => {
  mounted = await mountComponent(FormPlain, { call: async () => ({ errors: { title: '<img src=x onerror=alert(1)>' } }) })
  click(mounted.root.querySelector('#submit'))
  await settle()

  expect(mounted.root.querySelector('[data-field="title"] img')).toBeNull()
  expect(message(mounted.root)).toBe('<img src=x onerror=alert(1)>')
})
