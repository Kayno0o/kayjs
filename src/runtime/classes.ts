// A `class` given as an array: nested arrays flattened, an object's keys kept with their values, other truthy values as names.
export function flattenClasses(list: readonly unknown[], result: Record<string, unknown>): Record<string, unknown> {
  for (const item of list) {
    if (Array.isArray(item))
      flattenClasses(item, result)
    else if (typeof item === 'object' && item !== null)
      Object.assign(result, item)
    else if (typeof item !== 'boolean' && (Boolean(item) || item === 0))
      result[String(item)] = true
  }

  return result
}

// The `class` a component gets when its call merges a shorthand, a `class` attribute or a spread's: one string, as a `class?: string` prop takes it, or none when nothing is set.
export function componentClass(list: readonly unknown[]): string | undefined {
  const classes = flattenClasses(list, {})
  const names = Object.keys(classes).filter(key => key !== '' && key !== 'undefined' && Boolean(classes[key]))

  return names.length > 0 ? names.join(' ') : undefined
}
