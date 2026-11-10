import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import EmptyIssues from '../tests/fixture/src/components/empty-issues.kay'
import MarkedGroup from '../tests/fixture/src/components/marked-group.kay'
import RequiredFields from '../tests/fixture/src/components/required-fields.kay'
import RequiredToggled from '../tests/fixture/src/components/required-toggled.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function group() {
  mounted = await mountComponent(MarkedGroup, {})

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

  const issues = root.querySelector('fieldset > [data-part="issues"]')!.id

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
  mounted = await mountComponent(RequiredFields, {})
  await settle()

  const required = (id: string) => mounted!.root.querySelector(`#${id}`)!.getAttribute('aria-required')

  expect([required('title'), required('subtitle'), required('slug')]).toEqual(['true', null, 'false'])
  expect(mounted.root.querySelector('[data-part="required"]')?.getAttribute('aria-hidden')).toBe('true')
})

test('each field of a required group is announced as required, a FormField nested in it left alone', async () => {
  mounted = await mountComponent(RequiredFields, {})
  await settle()

  const required = (id: string) => mounted!.root.querySelector(`#${id}`)!.getAttribute('aria-required')

  expect([required('read'), required('write'), required('code')]).toEqual(['true', 'true', null])
})

test('a FormField with no message holds an empty live region that leaves no row gap, in both sizes and in a group, and a message fills it', async () => {
  mounted = await mountComponent(EmptyIssues, {})

  const { root } = mounted
  const lines = () => ['#medium', '#small', '#set'].map(id => root.querySelector(`${id} [data-part="issues"]`)!)

  for (const line of lines()) {
    expect(line.childElementCount).toBe(0)
    expect(line.textContent).toBe('')
    expect(line.getAttribute('aria-live')).toBe('polite')
    expect(line.className).toContain('empty:absolute')
  }

  click(root.querySelector('#refuse'))
  await settle()

  expect(lines().map(line => line.textContent)).toEqual(['Too short', 'Too short', 'Too short'])
})

test('a required field and each field of a required group take the native required, a box of the group aside, a field that wrote its own left alone', async () => {
  mounted = await mountComponent(RequiredFields, {})
  await settle()

  const native = (id: string) => (mounted!.root.querySelector(`#${id}`) as HTMLInputElement).required

  expect([native('title'), native('subtitle'), native('slug'), native('read'), native('write'), native('code')]).toEqual([true, false, true, false, false, false])
})

test('a required turned off takes back what the field set, and leaves what the page wrote', async () => {
  mounted = await mountComponent(RequiredToggled, {})
  await settle()

  const field = (id: string) => mounted!.root.querySelector<HTMLInputElement>(`#${id}`)!

  expect([field('title').required, field('title').getAttribute('aria-required'), field('read').getAttribute('aria-required'), field('own').required]).toEqual([true, 'true', 'true', true])

  click(mounted.root.querySelector('#off'))
  await settle()

  expect([field('title').required, field('title').getAttribute('aria-required'), field('read').getAttribute('aria-required'), field('own').required]).toEqual([false, null, null, true])
})

test('a required ChipGroup holds its form back while no chip is picked, and aria-required stays on each box', async () => {
  mounted = await mountComponent(RequiredToggled, {})
  await settle()

  const boxes = [...mounted.root.querySelectorAll<HTMLInputElement>('#chips input')]

  expect(boxes.map(box => box.getAttribute('aria-required'))).toEqual(['true', 'true'])
  expect(boxes.map(box => box.validity.valid)).toEqual([false, true])
  expect(boxes[0]!.validationMessage).toBe('Pick at least one')

  click(boxes[1]!)
  await settle()

  expect(boxes.map(box => box.validity.valid)).toEqual([true, true])

  click(boxes[1]!)
  await settle()

  expect(boxes[0]!.validity.valid).toBe(false)

  click(mounted.root.querySelector('#off'))
  await settle()

  expect(boxes[0]!.validity.valid).toBe(true)
})

test('a required ChipGroup whose first chip is disabled holds its form back on the first enabled one', async () => {
  mounted = await mountComponent(RequiredToggled, {})
  await settle()

  const boxes = [...mounted.root.querySelectorAll<HTMLInputElement>('#held input')]

  expect(boxes.map(box => box.validationMessage)).toEqual(['', 'Pick at least one'])
})

test('a ChipGroup in a required group FormField takes aria-required alone on its boxes', async () => {
  mounted = await mountComponent(RequiredToggled, {})
  await settle()

  const boxes = [...mounted.root.querySelectorAll<HTMLInputElement>('#framed input')]

  expect(boxes.map(box => [box.getAttribute('aria-required'), box.required])).toEqual([['true', false], ['true', false]])
})
