import { effect, signal, untrack } from 'kay'
import { changeAccepted } from './change'
import { onFormReset, resetWhenIdle, startRef } from './form-reset'

interface Options<Value extends boolean | number | string, Box extends HTMLInputElement> {
  // The control's name in a logged failure of its `onChange`.
  control: string
  // What the parent holds, and its `onChange`, read each time.
  value: () => Value
  onChange: () => ((value: Value) => unknown) | undefined
  // What the input reads, writes and defaults to, in the parent's terms.
  read: (input: Box) => Value
  write: (input: Box, value: Value) => void
  defaultOf: (input: Box) => Value
  setDefault: (input: Box, value: Value) => void
  // Runs on the input once drawn, besides setting its default from `value`.
  start?: ((input: Box) => void) | undefined
  // Runs on the input once a change settled, accepted or not.
  settled?: ((input: Box) => void) | undefined
  // Tells the parent the value a refused change or a form reset left, as `onInput` of a slider does.
  restored?: ((value: Value) => void) | undefined
  // The ref the app put on the control, which gets the input too.
  appRef?: unknown
}

// What Checkbox, Toggle, Slider and ColorInput share: an input the parent controls, held busy while its `onChange` promise is pending and put back when that is refused, and sent back to its default by a form reset.
// A parent echoing the value it was just told, from `onInput` or `onChange`, is not setting it: only a value other than the shown one counts as the parent answering, and one that moves onto the value of a change under way holds it whatever the answer.
export function controlledInput<Value extends boolean | number | string, Box extends HTMLInputElement = HTMLInputElement>({ control, value, onChange, read, write, defaultOf, setDefault, start, settled: afterChange, restored, appRef }: Options<Value, Box>): { shown: () => Value, busy: () => boolean, ref: (element: Box) => void, move: (input: Box) => boolean, change: (input: Box) => Promise<void> } {
  const shown = signal<Value>(untrack(value) as Exclude<Value, (...args: never[]) => unknown>)
  const busy = signal(false)
  let box: Box | undefined
  // The value the parent last accepted or set, which a refused change puts back.
  let accepted = untrack(value)
  // How often the parent's value reached the input, so a change under way knows whether the parent answered it.
  let synced = 0

  effect(() => {
    const wanted = value()

    if (wanted === untrack(shown))
      return

    shown.set(wanted)
    accepted = wanted
    synced++
  })

  // The control starts once: its default is what it was first drawn with, not what the parent holds now.
  const ref = startRef<Box>((element) => {
    box = element
    setDefault(element, untrack(value))
    start?.(element)
  }, appRef)

  // Whatever got past the held gestures moves nothing while a change is under way.
  function stopped(input: Box): boolean {
    if (!busy())
      return false

    write(input, shown())

    return true
  }

  // A control that follows the pointer or the keys before a change is let go of shows it without telling the parent; false while a change is under way.
  function move(input: Box): boolean {
    if (stopped(input))
      return false

    shown.set(read(input))

    return true
  }

  // A reset puts the control back on its default, which the app's `onChange` then hears of; one meeting a change under way waits for it.
  const resetting = resetWhenIdle(busy, () => {
    if (!box)
      return

    write(box, defaultOf(box))

    const next = read(box)

    if (next === shown())
      return

    shown.set(next)
    restored?.(next)
    void change(box)
  })

  async function change(input: Box): Promise<void> {
    if (stopped(input))
      return

    const next = read(input)
    const before = accepted
    const syncedBefore = synced
    const heldBefore = untrack(value)

    shown.set(next)

    const answered = await changeAccepted(control, () => onChange()?.(next), busy.set)

    // The parent set its value meanwhile, which has the last word.
    if (synced === syncedBefore) {
      // A value already equal to the change at its start is an echo; one that moved onto it since, even from inside `onChange`, is the parent holding it whatever the answer.
      if (answered || (heldBefore !== next && untrack(value) === next)) {
        accepted = next
      }
      else {
        shown.set(before)
        write(input, before)
        restored?.(before)
      }
    }

    afterChange?.(input)
    resetting.idle()
  }

  onFormReset(() => box, resetting.reset)

  return { shown, busy, ref, move, change }
}
