import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

// What a component leaves to the browser to draw, which the server HTML cannot hold.
const BROWSER_DRAWN: Record<string, string | undefined> = {
  'line-chart': '.kui-line-chart-plot',
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
  for (const input of root.querySelectorAll<HTMLInputElement>('input'))
    input.toggleAttribute('checked', input.checked)

  for (const option of root.querySelectorAll<HTMLOptionElement>('option'))
    option.toggleAttribute('selected', option.selected)

  return root.innerHTML
}

// The markup as a browser holds it: hydration markers and island wrappers gone, drawn ids numbered, attributes in a fixed order.
function canonical(html: string, browserDrawn = ''): string {
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

  // An empty value is none, and an effect adds the shortcut a form answers to.
  for (const element of holder.querySelectorAll('[aria-keyshortcuts]'))
    element.removeAttribute('aria-keyshortcuts')

  // A static page's server render writes `aria-required` itself, which the effect of the browser's render adds in its turn.
  for (const element of holder.querySelectorAll('[aria-required]'))
    element.removeAttribute('aria-required')

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
      expect(canonical(reflected(browser.root), BROWSER_DRAWN[name])).toBe(canonical(server, BROWSER_DRAWN[name]))

      // No id repeats.
      const ids = [...browser.root.querySelectorAll('[id]')].map(element => element.id)

      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])

      // Every control and image says what it is, unless hidden from screen readers.
      const unnamed = [...browser.root.querySelectorAll(NAMED)].filter(element => !element.closest('[aria-hidden="true"]') && nameOf(element) === '').map(element => element.outerHTML.slice(0, 120))

      expect(unnamed).toEqual([])
    })
  }
})
