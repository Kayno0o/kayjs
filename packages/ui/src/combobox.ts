export interface ComboboxOption<Value extends string = string> {
  value: Value
  label: string
  // Keeps the option from being picked; the arrow keys skip it.
  disabled?: boolean | undefined
}

// What a list-less combobox asks of its loader: the text typed so far.
export interface ComboboxQuery {
  q: string
}

// A list of options, or a function answering the options for a query, such as an action or a wrapped API call.
export type ComboboxOptions<Value extends string = string> = readonly ComboboxOption<Value>[] | ((input: ComboboxQuery) => PromiseLike<readonly ComboboxOption<Value>[]>)

// The options whose label holds the text typed, any case; all of them for a blank text.
export function matchingOptions<Value extends string>(options: readonly ComboboxOption<Value>[], text: string): readonly ComboboxOption<Value>[] {
  const needle = text.trim().toLowerCase()

  return needle ? options.filter(option => option.label.toLowerCase().includes(needle)) : options
}

// Whether a `create` row is offered for `text`: something is typed and no option is already named so.
export function offersCreate(options: readonly ComboboxOption[], text: string): boolean {
  const typed = text.trim().toLowerCase()

  return typed !== '' && !options.some(option => option.label.trim().toLowerCase() === typed)
}

// The index after `from` in `step` direction that is not disabled, wrapping at both ends, or -1 when every row is. `from` of -1 starts before the first row, or past the last going up.
export function enabledIndex(disabled: readonly boolean[], from: number, step: 1 | -1): number {
  const count = disabled.length

  for (let tried = 1; tried <= count; tried++) {
    const index = (((from < 0 && step === -1 ? count : from) + step * tried) % count + count) % count

    if (!disabled[index])
      return index
  }

  return -1
}
