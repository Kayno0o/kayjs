import { onCleanup, onMount } from 'kay'

const HOLD = 'kui-hold-defaults'

function formOf(element: Element): HTMLFormElement | null {
  if (element instanceof HTMLFormElement)
    return element

  return 'form' in element ? element.form as HTMLFormElement | null : element.closest('form')
}

// A ref that runs `first` on the control's element, then hands the `ref` the app put on the control the element too, as it would on a plain element.
// Kay runs a ref on a spread element again only when its identity changes, and this one is a single function, so the app's ref, read once, runs once as it would on a plain element, however its attributes change.
export function startRef<Target extends Element>(first: (element: Target) => void, app?: unknown): (element: Target) => void {
  return (element) => {
    first(element)

    if (typeof app === 'function')
      (app as (element: Target) => void)(element)
  }
}

// For a control that holds itself busy while the app answers a change: a reset meeting it mid-change waits for that change to settle, then restores the defaults, so it is neither dropped nor lost under the change's own answer.
// `reset` goes to onFormReset, `idle` to the end of the change.
export function resetWhenIdle(busy: () => boolean, restore: () => void): { reset: () => void, idle: () => void, waiting: () => boolean } {
  let pending = false

  // A control gone by the time the change settles has nothing left to restore.
  onCleanup(() => {
    pending = false
  })

  return {
    reset() {
      if (busy())
        pending = true
      else
        restore()
    },
    idle() {
      if (pending && !busy()) {
        pending = false
        restore()
      }
    },
    waiting: () => pending,
  }
}

// Runs `after` once the form holding the element has reset, when the controls hold their defaults again and a signal behind one can follow.
// `last` waits for the other controls to have followed, for what reads them all.
export function onFormReset(element: () => Element | undefined, after: () => void, last = false): void {
  onMount(() => {
    const target = element()
    const form = target && formOf(target)

    if (!form)
      return

    let live = true

    // The browser resets the controls once every listener has run, so they are read a task later; a listener that cancelled the reset leaves them alone.
    const run = (event: Event) => {
      if (live && !event.defaultPrevented)
        after()
    }
    const listener = (event: Event) => setTimeout(last ? () => setTimeout(run, 0, event) : run, 0, event)

    form.addEventListener('reset', listener)
    onCleanup(() => {
      live = false
      form.removeEventListener('reset', listener)
    })
  })
}

// For a control whose default lives in a signal rather than in its elements: `hold` reads what it holds as a form saves and returns what makes that its default, which runs once the save is done.
export function onFormDefaults(element: () => Element | undefined, hold: () => () => void): void {
  onMount(() => {
    const target = element()
    const form = target && formOf(target)

    if (!form)
      return

    const listener = (event: Event) => (event as CustomEvent<(() => void)[]>).detail.push(hold())

    form.addEventListener(HOLD, listener)
    onCleanup(() => form.removeEventListener(HOLD, listener))
  })
}

// Asks the controls of a form that keep their default in a signal to hold what they show now; the returned function makes it their default.
export function holdDefaults(form: HTMLFormElement): () => void {
  const adopt: (() => void)[] = []

  form.dispatchEvent(new CustomEvent(HOLD, { detail: adopt }))

  return () => {
    for (const keep of adopt)
      keep()
  }
}
