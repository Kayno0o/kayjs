import { effect, signal, uid, untrack } from 'kay'
import { changeAccepted } from './change'
import { onFormReset, resetWhenIdle, startRef } from './form-reset'

type Held = string | number | null

interface Options {
  // The control's name in a logged failure of its `onChange`.
  control: string
  // The class of its radios, which the group finds them by.
  input: string
  // What the parent holds, read each time.
  options: () => readonly { value: string | number }[]
  value: () => Held
  name: () => string | undefined
  onChange: () => ((value: Held) => unknown) | undefined
  // The ref the app put on the group, which gets the root too.
  appRef?: unknown
}

// What Segmented and RadioGroup share: real radios the parent controls, held busy while the `onChange` promise is pending, put back when it is refused, and sent back to their defaults by a form reset.
// Held as string or number: a signal cannot take a type parameter that might be a function.
export function controlledRadios({ control, input, options, value, name, onChange, appRef }: Options): { group: string, picked: () => Held, busy: () => boolean, ref: (element: HTMLElement) => void, pick: (next: string | number) => Promise<void> } {
  const group = name() ?? uid()
  const picked = signal<Held>(untrack(value))
  const busy = signal(false)
  let root: HTMLElement | undefined
  // How often the parent's `value` reached the group, so a change under way knows whether the parent answered it.
  let synced = 0

  effect(() => {
    picked.set(value())
    synced++
  })

  const radios = () => [...root?.querySelectorAll<HTMLInputElement>(input) ?? []]

  // Checks the radio of `wanted` again, in this group only: the binding may never have seen the radio that took the check.
  // Focus follows the check, as it does for a radio moved by an arrow key: one left on a radio that snapped back would read as unchecked to a screen reader while the group holds another.
  function check(wanted: Held) {
    const all = radios()
    const active = root?.ownerDocument.activeElement
    const focused = all.find(radio => radio === active)

    // Radios follow the options in order, so the option is found by place, not by its text.
    for (const [index, radio] of all.entries())
      radio.checked = wanted !== null && options()[index]?.value === wanted

    if (focused && !focused.checked)
      all.find(radio => radio.checked)?.focus()
  }

  const started = () => options()[radios().findIndex(radio => radio.defaultChecked)]?.value ?? null

  // A reset puts the radios back on their defaults, which the app's `onChange` then hears of, `null` for a group that started with none picked.
  // One meeting a change under way waits for it.
  const resetting = resetWhenIdle(busy, () => {
    const next = started()

    check(next)

    if (next === picked())
      return

    void change(next)
  })

  async function change(next: Held) {
    const before = picked()
    const syncedBefore = synced

    picked.set(next)

    // Put back unless the parent set `value` meanwhile, which has the last word.
    if (!(await changeAccepted(control, () => onChange()?.(next), busy.set)) && synced === syncedBefore) {
      picked.set(before)
      check(before)
    }

    resetting.idle()
  }

  async function pick(next: string | number) {
    // A pick while a change is under way takes nothing: the radio checked by the click, a key or a label, is put back, on the start when a reset is waiting.
    if (busy()) {
      check(resetting.waiting() ? started() : picked())

      return
    }

    await change(next)
  }

  onFormReset(() => root, resetting.reset)

  return { group, picked, busy, ref: startRef<HTMLElement>(element => root = element, appRef), pick }
}
