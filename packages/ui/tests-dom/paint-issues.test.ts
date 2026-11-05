import { afterEach, expect, test } from 'bun:test'
import { liveElements } from '../src/field-look'
import { paintIssues } from '../src/internal/paint-issues'

afterEach(() => {
  document.body.innerHTML = ''
})

// The markup the server writes for a FormField given to a form as children.
const field = (name: string, extra = '') => `<div data-kui-field="f-${name}"><label><input name="${name}">${extra}</label><span data-part="issues" aria-live="polite" data-field="${name}"></span></div>`

function page(html: string) {
  document.body.innerHTML = html

  return document.body.querySelectorAll('form')
}

test('writes a message with its link and invalid mark, then takes all three away', () => {
  const [form] = page(`<form>${field('handle')}</form>`)
  const input = form!.querySelector('input')!
  const messages = form!.querySelector('[data-field]')!

  paintIssues(form!, { handle: 'Too short' })
  expect([messages.textContent, input.getAttribute('aria-invalid'), input.getAttribute('aria-describedby') === messages.id, messages.id !== '']).toEqual(['Too short', 'true', true, true])

  paintIssues(form!, { handle: 'Taken' })
  expect(messages.textContent).toBe('Taken')
  expect(messages.children).toHaveLength(1)

  paintIssues(form!, {})
  expect([messages.children.length, input.getAttribute('aria-invalid'), input.getAttribute('aria-describedby'), messages.hasAttribute('id')]).toEqual([0, null, null, false])
})

test('takes over the message and the mark a refused post rendered, and keeps the page\'s own issue, which still marks the field', () => {
  const [form] = page(`<form><div data-kui-field="f-a"><label><input name="a" aria-invalid="true" aria-describedby="m"></label><span data-part="issues" id="m" data-field="a"><span class="x" data-part="issue" data-form-issue>Old</span><span data-part="issue">Page note</span></span></div></form>`)
  const input = form!.querySelector('input')!

  paintIssues(form!, { a: 'New' })
  expect([...form!.querySelectorAll('[data-field] > span')].map(message => message.textContent)).toEqual(['New', 'Page note'])
  expect(form!.querySelector('[data-form-issue]')!.className).toBe('x')

  paintIssues(form!, {})
  expect([...form!.querySelectorAll('[data-field] > span')].map(message => message.textContent)).toEqual(['Page note'])
  expect([input.getAttribute('aria-invalid'), input.getAttribute('aria-describedby')]).toEqual(['true', 'm'])
})

test('sets a hostile message as text', () => {
  const [form] = page(`<form>${field('a')}</form>`)

  paintIssues(form!, { a: '<img src=x onerror=alert(1)>' })
  expect(form!.querySelector('img')).toBeNull()
  expect(form!.querySelector('[data-form-issue]')!.textContent).toBe('<img src=x onerror=alert(1)>')
})

test('leaves the fields of another form, of a nested form and of a component running in the browser alone', () => {
  const [first, second] = page(`<form id="a">${field('x')}</form><form id="b">${field('x')}</form>`)

  liveElements.add(second!.querySelector('[data-kui-field]')!)
  paintIssues(first!, { x: 'Refused' })
  expect(first!.querySelector('[data-form-issue]')).not.toBeNull()
  expect(second!.querySelector('[data-form-issue]')).toBeNull()

  paintIssues(second!, { x: 'Refused' })
  expect(second!.querySelector('[data-form-issue]')).toBeNull()
})

test('marks every field of a group and the group itself', () => {
  const [form] = page(`<form><fieldset data-kui-field="g"><legend>Access</legend><input id="one" name="access" type="checkbox"><input id="two" name="access" type="checkbox"><span data-part="issues" data-field="access"></span></fieldset></form>`)
  const group = form!.querySelector('fieldset')!
  const id = () => form!.querySelector('[data-field]')!.id

  paintIssues(form!, { access: 'Choose one' })
  expect([...form!.querySelectorAll('input')].map(input => [input.getAttribute('aria-invalid'), input.getAttribute('aria-describedby') === id()])).toEqual([['true', true], ['true', true]])
  expect(group.getAttribute('aria-describedby')).toBe(id())

  paintIssues(form!, {})
  expect([...form!.querySelectorAll('input')].map(input => input.getAttribute('aria-invalid'))).toEqual([null, null])
  expect(group.hasAttribute('aria-describedby')).toBe(false)
})

test('marks a Checkbox on its own, and leaves it to the FormField of the same name', () => {
  const [alone, framed] = page(`<form id="a"><slot data-component="node_modules/@kaynooo/kayjs-ui/src/checkbox.kay"><div data-part="field"><label><input type="checkbox" name="terms"></label><span data-part="issues" data-field="terms"></span></div></slot></form><form id="b"><div data-kui-field="f"><label><div data-part="field"><label><input type="checkbox" name="terms"></label><span data-part="issues" data-field="terms"></span></div></label><span data-part="issues" data-field="terms"></span></div></form>`)

  paintIssues(alone!, { terms: 'Accept' })
  expect([alone!.querySelector('[data-form-issue]')!.textContent, alone!.querySelector('input')!.getAttribute('aria-invalid')]).toEqual(['Accept', 'true'])

  paintIssues(framed!, { terms: 'Accept' })
  expect(framed!.querySelectorAll('[data-form-issue]')).toHaveLength(1)
  expect(framed!.querySelector('[data-kui-field] > [data-field]')!.textContent).toBe('Accept')
})
