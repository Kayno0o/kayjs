export interface MultiSelectOption<Value extends string = string> {
  value: Value
  label: string
}

// The trigger's text: the placeholder, the one label picked, or a count.
export function selectionSummary<Value extends string>(options: readonly MultiSelectOption<Value>[], value: readonly Value[], placeholder: string, counted: (count: number) => string = count => `${count} selected`): string {
  if (value.length === 0)
    return placeholder

  if (value.length === 1)
    return pickedLabels(options, value)[0]!

  return counted(value.length)
}

// The label of each value picked, or the value itself when no option names it.
export function pickedLabels<Value extends string>(options: readonly MultiSelectOption<Value>[], value: readonly Value[]): string[] {
  return value.map(entry => options.find(option => option.value === entry)?.label ?? entry)
}

// `value` with every option in `shown` picked, or none of them, the rest left as they were and kept in the options' order.
export function pickedShown<Value extends string>(options: readonly MultiSelectOption<Value>[], value: readonly Value[], shown: readonly MultiSelectOption<Value>[], pick: boolean): Value[] {
  const affected = new Set(shown.map(option => option.value))
  const next = new Set(value.filter(entry => !affected.has(entry)))

  if (pick) {
    for (const entry of affected)
      next.add(entry)
  }

  const known = options.map(entry => entry.value)

  return [...known.filter(entry => next.has(entry)), ...value.filter(entry => next.has(entry) && !known.includes(entry))]
}

// `value` with `option` flipped, kept in the options' order, with values no option names left at the end.
export function toggledValue<Value extends string>(options: readonly MultiSelectOption<Value>[], value: readonly Value[], option: Value): Value[] {
  const next = value.includes(option) ? value.filter(entry => entry !== option) : [...value, option]
  const known = options.map(entry => entry.value)

  return [...known.filter(entry => next.includes(entry)), ...next.filter(entry => !known.includes(entry))]
}
