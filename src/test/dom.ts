import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Listed under `[test] preload` in bunfig.toml after `kay/test/preload`, so `mountComponent()` renders into happy-dom's document in every test file.
// The web globals a server or its fake upstream uses stay Bun's: `Bun.serve` refuses a happy-dom `Response`, and its `fetch` does not reach a Bun server.
const KEPT = ['fetch', 'Request', 'Response', 'Headers', 'Blob', 'File', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'WebSocket']
const kept = KEPT.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)

const NativeFormData = FormData

GlobalRegistrator.register()

const DomFormData = FormData

for (const [name, descriptor] of kept) {
  if (descriptor !== undefined)
    Object.defineProperty(globalThis, name, descriptor)
}

// Bun's FormData ignores a form element, which the runtime and components read forms through, so this one takes happy-dom's reading of the form and stays Bun's class otherwise. A happy-dom file keeps its name, type and bytes, which it holds under a symbol, and a Bun File set on a file input is passed through, as happy-dom would turn it into text.
function bytesOf(file: Blob): ArrayBuffer {
  const symbol = Object.getOwnPropertySymbols(file).find(key => key.description === 'buffer')
  const bytes = symbol === undefined ? new Uint8Array() : (file as unknown as Record<symbol, Uint8Array>)[symbol]!

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

class FormDataWithForm extends NativeFormData {
  constructor(form?: HTMLFormElement, submitter?: HTMLElement) {
    super()

    if (form === undefined)
      return

    const picked = new Map<string, File[]>()

    for (const input of form.querySelectorAll<HTMLInputElement>('input[type=file]')) {
      const files = [...(input.files ?? [])].filter(file => file instanceof File)

      if (files.length > 0)
        picked.set(input.name, [...(picked.get(input.name) ?? []), ...files])
    }

    for (const [name, value] of new DomFormData(form, submitter) as unknown as Iterable<[string, FormDataEntryValue]>) {
      if (typeof value === 'string')
        this.append(name, value.startsWith('[object ') ? (picked.get(name)?.shift() ?? value) : value)
      else
        this.append(name, new File([bytesOf(value)], value.name, { type: value.type, lastModified: value.lastModified }))
    }
  }
}

Object.defineProperty(globalThis, 'FormData', { value: FormDataWithForm, writable: true, configurable: true })

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
