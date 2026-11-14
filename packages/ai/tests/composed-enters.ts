import type { TestPage } from 'kay/test'

// Both Enters that belong to an IME composition, the second Safari's closing one, sent to the field: true when either was acted on.
export async function composedEnters(page: TestPage, selector: string) {
  return page.evaluate((target: string) => {
    const field = document.querySelector(target)!

    return [{ isComposing: true }, { keyCode: 229 }].some((init) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })

      field.dispatchEvent(event)

      return event.defaultPrevented
    })
  }, selector)
}
