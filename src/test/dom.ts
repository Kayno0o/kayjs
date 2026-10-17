import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Listed under `[test] preload` in bunfig.toml after `kay/test/preload`, so `mountComponent()` renders into happy-dom's document in every test file.
GlobalRegistrator.register()

// happy-dom has no popover API: an element shown keeps a flag, which `:popover-open` matches, and `toggle` fires as in a browser.
if (!('showPopover' in HTMLElement.prototype)) {
  const open = new WeakSet<Element>()
  const matches = Object.getOwnPropertyDescriptor(Element.prototype, 'matches')!.value as (this: Element, selector: string) => boolean

  const popover = (element: HTMLElement, show: boolean): void => {
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
}
