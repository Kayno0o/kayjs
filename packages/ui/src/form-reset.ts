import { onCleanup, onMount } from 'kay'

const HOLD = 'kui-hold-defaults'

const formOf = (element: Element) => 'form' in element ? element.form as HTMLFormElement | null : element.closest('form')

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
