const WHITESPACE = /\s+/g

const warned = new Set<string>()

// Development only: one console warning per message.
export function warnOnce(message: string): void {
  if (warned.has(message))
    return

  warned.add(message)
  console.warn(`[kay] ${message}`)
}

export function sourceStart(fn: (...args: never[]) => unknown): string {
  return fn.name || fn.toString().replace(WHITESPACE, ' ').slice(0, 80)
}
