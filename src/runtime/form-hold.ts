import { listen, submits } from './dom'

// Kept out of the entry: only an island listening to `submit` loads it. While it answers a promise the form and its submit buttons are `aria-busy`, which kayjs-ui styles as a spinner.
const holds = new WeakMap<Element, number>()
const marked = new WeakSet<Element>()

function holding(handler: (event: Event) => void): (event: Event) => void {
  return function (this: unknown, event) {
    const answer: unknown = handler.call(this, event)

    if (typeof answer === 'object' && answer !== null && typeof Reflect.get(answer, 'then') === 'function' && event.currentTarget instanceof HTMLFormElement)
      void hold(event.currentTarget, answer as PromiseLike<unknown>)
  }
}

function setBusy(form: HTMLFormElement, busy: boolean): void {
  for (const element of [form, ...form.elements]) {
    if (element !== form && !(element instanceof HTMLButtonElement && element.type === 'submit'))
      continue

    // One the page marked busy itself is left as it is.
    if (busy && !element.hasAttribute('aria-busy')) {
      element.setAttribute('aria-busy', 'true')
      marked.add(element)
    }
    else if (!busy && marked.delete(element)) {
      element.removeAttribute('aria-busy')
    }
  }
}

async function hold(form: HTMLFormElement, answer: PromiseLike<unknown>): Promise<void> {
  holds.set(form, (holds.get(form) ?? 0) + 1)
  setBusy(form, true)

  // A rejection is rethrown once the hold is released, so it is reported as it would be without one; a handler that catches its own promise's rejection still has it reported.
  try {
    await answer
  }
  finally {
    const left = holds.get(form)! - 1

    holds.set(form, left)

    if (left === 0)
      setBusy(form, false)
  }
}

// Listens like `listen`, a `submit` handler held.
export function listenSubmit(element: Element, name: string, handler: (event: Event) => void): void {
  holdSubmits()
  listen(element, name, name.toLowerCase() === 'onsubmit' ? holding(handler) : handler)
}

// Makes a `submit` handler a spread gives hold too, which a form spreading its props asks for at compile time.
export function holdSubmits(): void {
  submits.listen = listenSubmit
}
