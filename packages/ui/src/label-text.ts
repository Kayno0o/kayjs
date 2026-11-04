const PLACEHOLDER = /\{(\w+)\}/g

// A `*Label` prop that is text or a function of what it names: a string is used as written, `{count}`-style placeholders filled from `values`.
export function labelText<Args extends unknown[]>(label: string | ((...args: Args) => string), values: Record<string, string | number>, ...args: Args): string {
  if (typeof label === 'function')
    return label(...args)

  return label.replace(PLACEHOLDER, (placeholder, name: string) => String(values[name] ?? placeholder))
}
