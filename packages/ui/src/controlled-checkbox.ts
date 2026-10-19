import { effect, signal, untrack } from 'kay'
import { changeAccepted } from './change'
import { onFormReset, resetWhenIdle, startRef } from './form-reset'

interface Options {
  // The control's name in a logged failure of its `onChange`.
  control: string
  // What the parent holds, and its `onChange`, read each time.
  checked: () => boolean
  onChange: () => ((checked: boolean) => unknown) | undefined
  // Runs on the input once drawn, besides setting its default from `checked`.
  start?: ((input: HTMLInputElement) => void) | undefined
  // Runs on the input once a change settled.
  settled?: ((input: HTMLInputElement) => void) | undefined
  // The ref the app put on the control, which gets the input too.
  appRef?: unknown
}

// What Checkbox and Toggle share: a native checkbox the parent controls, held busy while its `onChange` promise is pending and put back when that is refused, and sent back to its default by a form reset.
export function controlledCheckbox({ control, checked, onChange, start, settled, appRef }: Options): { on: () => boolean, busy: () => boolean, ref: (element: HTMLInputElement) => void, change: (input: HTMLInputElement) => Promise<void> } {
  const on = signal(untrack(checked))
  const busy = signal(false)
  let box: HTMLInputElement | undefined
  // How often the parent's `checked` reached the control, so a change under way knows whether the parent answered it.
  let synced = 0

  effect(() => {
    on.set(checked())
    synced++
  })

  // The control starts once: its default is what it was first drawn with, not what the parent holds now.
  const ref = startRef<HTMLInputElement>((element) => {
    box = element
    element.defaultChecked = untrack(checked)
    start?.(element)
  }, appRef)

  // A reset puts the control back on its default, which the app's `onChange` then hears of; one meeting a change under way waits for it.
  const resetting = resetWhenIdle(busy, () => {
    if (!box)
      return

    box.checked = box.defaultChecked

    if (box.checked !== on())
      void change(box)
  })

  onFormReset(() => box, resetting.reset)

  async function change(input: HTMLInputElement): Promise<void> {
    const next = input.checked
    const before = on()
    const syncedBefore = synced

    on.set(next)

    // Put back unless the parent set `checked` meanwhile, which has the last word. The input too, since a change refused at once never renders `on` as flipped for the binding to undo.
    const accepted = await changeAccepted(control, () => onChange()?.(next), busy.set)

    if (!accepted && synced === syncedBefore) {
      on.set(before)
      input.checked = before
    }

    settled?.(input)
    resetting.idle()
  }

  return { on, busy, ref, change }
}
