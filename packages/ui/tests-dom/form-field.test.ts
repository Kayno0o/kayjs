import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function group() {
  mounted = await mountComponent('src/components/marked-group.kay', {})

  const { root } = mounted
  const marks = (id: string) => {
    const field = root.querySelector(`#${id}`)!

    return [field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')]
  }

  return { root, marks }
}

test('a group\'s message leaves aria-invalid on a field the page marked once it clears, taking only its own id out of aria-describedby', async () => {
  const { root, marks } = await group()

  click(root.querySelector('#refuse'))
  await settle()

  const issues = root.querySelector('fieldset > .kui-form-field-issues')!.id

  expect([marks('marked'), marks('plain')]).toEqual([['true', `marked-note ${issues}`], ['true', issues]])

  click(root.querySelector('#clear'))
  await settle()

  expect([marks('marked'), marks('plain')]).toEqual([['true', 'marked-note'], [null, null]])
})

test('a group\'s message leaves the field of a FormField nested in it alone', async () => {
  const { root, marks } = await group()

  click(root.querySelector('#refuse'))
  await settle()

  expect(marks('code')).toEqual([null, null])

  click(root.querySelector('#clear'))
  await settle()

  expect(marks('code')).toEqual([null, null])
})

test('a required field\'s control is announced as required, the star beside its label being hidden from a screen reader', async () => {
  mounted = await mountComponent('src/components/required-fields.kay', {})
  await settle()

  const required = (id: string) => mounted!.root.querySelector(`#${id}`)!.getAttribute('aria-required')

  expect([required('title'), required('subtitle'), required('slug')]).toEqual(['true', null, 'false'])
  expect(mounted.root.querySelector('.kui-form-field-required')?.getAttribute('aria-hidden')).toBe('true')
})

test('each field of a required group is announced as required, a FormField nested in it left alone', async () => {
  mounted = await mountComponent('src/components/required-fields.kay', {})
  await settle()

  const required = (id: string) => mounted!.root.querySelector(`#${id}`)!.getAttribute('aria-required')

  expect([required('read'), required('write'), required('code')]).toEqual(['true', 'true', null])
})
