export interface MultiSelectOption {
  value: string
  label: string
}

// The trigger's text: the placeholder, the one label picked, or a count.
export function selectionSummary(options: readonly MultiSelectOption[], value: readonly string[], placeholder: string): string {
  if (value.length === 0)
    return placeholder

  if (value.length === 1)
    return options.find(option => option.value === value[0])?.label ?? value[0]!

  return `${value.length} selected`
}

// `value` with `option` flipped, kept in the options' order, with values no option names left at the end.
export function toggledValue(options: readonly MultiSelectOption[], value: readonly string[], option: string): string[] {
  const next = value.includes(option) ? value.filter(entry => entry !== option) : [...value, option]
  const known = options.map(entry => entry.value)

  return [...known.filter(entry => next.includes(entry)), ...next.filter(entry => !known.includes(entry))]
}
