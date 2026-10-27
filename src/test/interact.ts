// What a mounted component's `type`, `click` and `press` do: the events a browser fires for the same gesture, then a settle.
export interface Interactions {
  // Focuses the field `selector` matches under the root and puts `text` in it, firing `input` as typing does; a `select` takes the option whose value or label is `text` and fires `input` and `change` at once.
  // A text field's `change` comes with the commit a browser makes: Enter, a click elsewhere or another field's `type`.
  type: (selector: string, text: string) => Promise<void>
  // Clicks the element `selector` matches under the root, focusing it as a pointer does, with the events a browser fires: `pointerdown`, `mousedown`, `pointerup`, `mouseup` and `click`. A disabled element does nothing, and a radio or checkbox changes as it does for a user.
  click: (selector: string) => Promise<void>
  // Presses a key on the focused element, such as `Enter` or `Escape`: `keydown`, `keyup` and what the key does by default (Enter commits a text field and submits its form, Enter and Space click a button), unless `keydown` is prevented.
  press: (key: string) => Promise<void>
}

type Field = HTMLInputElement | HTMLTextAreaElement

// The fields typed into whose `change` a browser has not fired yet.
const uncommitted = new WeakSet<Element>()

export function interactions(root: HTMLElement, settle: () => Promise<void>): Interactions {
  const find = (selector: string, action: string): HTMLElement => {
    const found = root.querySelector<HTMLElement>(selector)

    if (found === null)
      throw new Error(`kay: ${action}(${JSON.stringify(selector)}) matches nothing in the mounted component`)

    return found
  }

  return {
    type: async (selector, text) => {
      const element = find(selector, 'type')

      if (element instanceof HTMLSelectElement) {
        const option = [...element.options].find(candidate => candidate.value === text) ?? [...element.options].find(candidate => candidate.text === text)

        if (option === undefined)
          throw new Error(`kay: type(${JSON.stringify(selector)}, ${JSON.stringify(text)}): the select has no option with that value or label`)

        focused(element)
        element.value = option.value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }
      else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        focused(element)
        write(element, text)
        uncommitted.add(element)
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      }
      else {
        throw new TypeError(`kay: type(${JSON.stringify(selector)}) needs an input, textarea or select, not a ${element.localName}`)
      }

      await settle()
    },
    click: async (selector) => {
      const element = find(selector, 'click')
      const target = element.closest<HTMLElement>('button, input, select, textarea, a[href], [tabindex]') ?? element

      // Disabled controls swallow every pointer event, as in a browser.
      if (!('disabled' in element && element.disabled === true)) {
        for (const type of ['pointerdown', 'mousedown'])
          element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 }))

        focused(target)

        for (const type of ['pointerup', 'mouseup'])
          element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 }))

        element.click()
      }

      await settle()
    },
    press: async (key) => {
      const element = document.activeElement ?? document.body
      const init = { key, bubbles: true, cancelable: true, composed: true }

      if (element.dispatchEvent(new KeyboardEvent('keydown', init))) {
        if (key === 'Enter' && element instanceof HTMLInputElement) {
          commit(element)
          element.form?.requestSubmit()
        }
        else if (key === 'Enter' && element instanceof HTMLButtonElement) {
          element.click()
        }
        else if (key === ' ' && element instanceof HTMLButtonElement) {
          // A button clicks on the release of Space.
          element.dispatchEvent(new KeyboardEvent('keyup', init))
          element.click()
          await settle()

          return
        }
      }

      element.dispatchEvent(new KeyboardEvent('keyup', init))

      await settle()
    },
  }
}

// Focuses as a pointer or Tab does, committing the field it leaves.
function focused(element: HTMLElement): void {
  const left = document.activeElement

  if (left !== null && left !== element)
    commit(left)

  element.focus()
}

// Fires the `change` a browser fires when a text field typed into is left or Enter is pressed in it.
function commit(element: Element): void {
  if (!uncommitted.delete(element))
    return

  element.dispatchEvent(new Event('change', { bubbles: true }))
}

// Through the prototype's setter, so a framework wrapping the instance's `value` still sees the write as a user's.
function write(element: Field, text: string): void {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype

  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text)
}
