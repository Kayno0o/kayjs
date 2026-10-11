import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

// happy-dom has no popover API: an element shown keeps a flag, which `:popover-open` matches, and `toggle` fires as in a browser.
const open = new WeakSet<Element>()
const matches = Element.prototype.matches

function popover(element: HTMLElement, show: boolean): void {
  if (open.has(element) === show)
    return

  if (show)
    open.add(element)
  else
    open.delete(element)

  element.dispatchEvent(Object.assign(new Event('toggle'), { oldState: show ? 'closed' : 'open', newState: show ? 'open' : 'closed' }))
}

Object.assign(HTMLElement.prototype, {
  showPopover(this: HTMLElement) {
    popover(this, true)
  },
  hidePopover(this: HTMLElement) {
    popover(this, false)
  },
  togglePopover(this: HTMLElement, force?: boolean) {
    popover(this, force ?? !open.has(this))

    return open.has(this)
  },
})

Object.assign(Element.prototype, {
  matches(this: Element, selector: string) {
    return selector === ':popover-open' ? open.has(this) : matches.call(this, selector)
  },
})

// Components mount from the fixture app, which installs the library and replaces its settings as an app does.
process.env.KAY_ROOT = join(import.meta.dir, '..', 'tests', 'fixture')

// A component of the library, by its path under the fixture's node_modules.
export function library(name: string): string {
  return `node_modules/@kaynooo/kayjs-ui/src/${name}.kay`
}

export function click(element: Element | null): void {
  if (!(element instanceof HTMLElement))
    throw new Error('nothing to click')

  element.click()
}
