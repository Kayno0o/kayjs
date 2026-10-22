import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

// What a component leaves to the browser to draw, which the server HTML cannot hold.
const BROWSER_DRAWN: Record<string, string | undefined> = {
  'line-chart': '.kui-line-chart-plot',
  // The bar's buttons load in a chunk of their own once the editor is on the page, the server holding the empty bar they fill.
  'markdown-editor': '.kui-markdown-bar',
}

// What the browser adds once the island runs, the server holding the plain date field alone: the calendar's button and panel.
const BROWSER_ADDED: Record<string, string | undefined> = {
  'date-input': '.kui-date-input-trigger, .kui-date-input-panel',
  'date-range-input': '.kui-date-input-trigger, .kui-date-input-panel',
}

// What an effect adds to the browser's render while the server's holds none, by component.
const EFFECT_ADDED: Record<string, string | undefined> = {
  'contact-form': 'aria-required',
}

// What the browser takes off once it runs while the server's markup holds it, by component: the native suggestion list a combobox hands over to its own.
const EFFECT_REMOVED: Record<string, string | undefined> = {
  combobox: 'list',
}

// The fixture app is no part of this package's type check, so its table is imported by a path no import is resolved for.
const { CASES } = await import(join(process.env.KAY_ROOT!, 'src', 'contract.ts')) as { CASES: Record<string, unknown> }
const mounted: { unmount: () => void }[] = []

afterEach(() => {
  for (const one of mounted.splice(0))
    one.unmount()
})

// What `uid()` draws, which differs per render and per hydration, numbered in order of appearance.
const DRAWN = /\bK\d+(?:-\d+)?/g

// What the browser holds as properties, a box ticked or an option picked, written as the attributes the server's markup holds.
function reflected(root: Element): string {
  for (const input of root.querySelectorAll<HTMLInputElement>('input')) {
    input.toggleAttribute('checked', input.checked)

    // A combobox's text is the value the browser holds, which the server writes as the attribute.
    if (input.getAttribute('role') === 'combobox')
      input.setAttribute('value', input.value)
  }

  for (const option of root.querySelectorAll<HTMLOptionElement>('option'))
    option.toggleAttribute('selected', option.selected)

  return root.innerHTML
}

// The markup as a browser holds it: hydration markers and island wrappers gone, drawn ids numbered, attributes in a fixed order.
function canonical(html: string, browserDrawn = '', effectAdded = '', effectRemoved = '', browserAdded = ''): string {
  const holder = document.createElement('div')

  holder.innerHTML = html

  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_COMMENT)
  const comments: Node[] = []

  for (let node = walker.nextNode(); node; node = walker.nextNode())
    comments.push(node)

  for (const comment of comments)
    comment.parentNode?.removeChild(comment)

  for (const slot of holder.querySelectorAll('slot[data-component]'))
    slot.replaceWith(...slot.childNodes)

  // What only the browser draws, such as a chart's plot, is left out of both.
  if (browserDrawn) {
    for (const element of holder.querySelectorAll(browserDrawn))
      element.replaceChildren()
  }

  if (browserAdded) {
    for (const element of holder.querySelectorAll(browserAdded))
      element.remove()
  }

  // The server render here reads the library's own icons and the browser build the fixture's settings, which replace the close icon, so an icon's drawing is left out of both.
  for (const path of holder.querySelectorAll('.kui-icon path'))
    path.removeAttribute('d')

  // An empty value is none, and an effect adds the shortcut a form answers to.
  for (const element of holder.querySelectorAll('[aria-keyshortcuts]'))
    element.removeAttribute('aria-keyshortcuts')

  // Only the browser's side is stripped of it, so a server render that starts writing it too is seen.
  if (effectAdded) {
    for (const element of holder.querySelectorAll(`[${effectAdded}]`))
      element.removeAttribute(effectAdded)
  }

  if (effectRemoved) {
    for (const element of holder.querySelectorAll(`[${effectRemoved}]`))
      element.removeAttribute(effectRemoved)
  }

  // Once the browser runs a combobox posts the value picked from a hidden field, where the server's input posts its text: both are the one name on the input.
  for (const hidden of holder.querySelectorAll('.kui-combobox > input[type="hidden"]')) {
    hidden.parentElement?.querySelector('[role="combobox"]')?.setAttribute('name', hidden.getAttribute('name') ?? '')
    hidden.remove()
  }

  for (const element of holder.querySelectorAll('[value=""]'))
    element.removeAttribute('value')

  holder.normalize()

  const seen = new Map<string, number>()
  const text = serialise(holder).replaceAll(DRAWN, id => `#${seen.set(id, seen.get(id) ?? seen.size + 1).get(id)}`)

  return text
}

function serialise(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return node.textContent ?? ''

  if (!(node instanceof Element))
    return ''

  const attributes = [...node.attributes].map(({ name, value }) => `${name}="${value}"`).sort().join(' ')

  return `<${node.localName}${attributes ? ` ${attributes}` : ''}>${[...node.childNodes].map(serialise).join('')}</${node.localName}>`
}

// What names an element: the elements its aria-labelledby points at, its aria-label, its label, its title or alt, or the text it holds, as a screen reader reads it.
function nameOf(element: Element): string {
  const labelled = element.getAttribute('aria-labelledby')

  if (labelled !== null)
    return labelled.split(' ').map(id => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim()

  const role = element.getAttribute('role')
  const holdsText = element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement || role === 'tab' || role === 'menuitem' || role === 'option'
  const label = (element.id === '' ? null : element.ownerDocument.querySelector(`label[for="${element.id}"]`)) ?? element.closest('label')

  return [element.getAttribute('aria-label'), label?.textContent, element.getAttribute('title'), element.getAttribute('alt'), holdsText ? element.textContent : ''].map(text => text?.trim() ?? '').find(text => text !== '') ?? ''
}

// Controls and images a screen reader announces, which must say what they are.
const NAMED = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="slider"], [role="switch"], [role="tab"], [role="radiogroup"], [role="group"], [role="meter"], [role="img"], [role="menuitem"], [role="figure"], [role="listbox"], [role="tree"], [role="dialog"], dialog'

test('every component the library exports has fixture props', () => {
  const exported = readdirSync(join(import.meta.dir, '..', 'src')).filter(file => file.endsWith('.kay')).map(file => file.slice(0, -4)).sort()

  expect(Object.keys(CASES).sort()).toEqual(exported)
})

describe('component contract', () => {
  const wrapper = 'src/components/contract.kay'

  for (const name of Object.keys(CASES)) {
    test(name, async () => {
      const { default: render } = await import(`${process.env.KAY_ROOT}/${wrapper}`) as { default: (props: { name: string }) => { t: string } }
      const server = render({ name }).t
      const browser = await mountComponent(wrapper, { name })

      mounted.push(browser)

      // The server and the browser's first render draw the same page.
      expect(canonical(reflected(browser.root), BROWSER_DRAWN[name], EFFECT_ADDED[name], undefined, BROWSER_ADDED[name])).toBe(canonical(server, BROWSER_DRAWN[name], undefined, EFFECT_REMOVED[name]))

      // No id repeats.
      const ids = [...browser.root.querySelectorAll('[id]')].map(element => element.id)

      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])

      // Every control and image says what it is, unless hidden from screen readers.
      const unnamed = [...browser.root.querySelectorAll(NAMED)].filter(element => !element.closest('[aria-hidden="true"]') && nameOf(element) === '').map(element => element.outerHTML.slice(0, 120))

      expect(unnamed).toEqual([])
    })
  }

  // The bar's buttons come from a chunk loaded after mount, so the comparison above leaves them out: they must appear, and be named.
  test('markdown-editor hydrates its toolbar buttons', async () => {
    const browser = await mountComponent(wrapper, { name: 'markdown-editor' })

    mounted.push(browser)

    for (let tries = 0; tries < 400 && browser.root.querySelector('.kui-markdown-bar button') === null; tries++)
      await Bun.sleep(5)

    const buttons = [...browser.root.querySelectorAll('.kui-markdown-bar button')]

    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.filter(button => nameOf(button) === '')).toEqual([])
  })
})
