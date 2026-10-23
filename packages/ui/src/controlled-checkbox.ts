import { controlledInput } from './controlled-input'

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

// What Checkbox and Toggle share: a native checkbox the parent controls, on the helper every controlled input shares.
export function controlledCheckbox({ control, checked, onChange, start, settled, appRef }: Options): { on: () => boolean, busy: () => boolean, ref: (element: HTMLInputElement) => void, change: (input: HTMLInputElement) => Promise<void> } {
  const { shown, busy, ref, change } = controlledInput<boolean>({
    control,
    value: checked,
    onChange,
    read: input => input.checked,
    write: (input, next) => {
      input.checked = next
    },
    defaultOf: input => input.defaultChecked,
    setDefault: (input, next) => {
      input.defaultChecked = next
    },
    start,
    settled,
    appRef,
  })

  return { on: shown, busy, ref, change }
}
