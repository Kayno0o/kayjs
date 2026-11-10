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

// Development only: a helper called with no owner, which nothing but its own handle ever stops.
export function warnUnowned(api: string, named: (...args: never[]) => unknown): void {
  if (process.env.NODE_ENV !== 'production')
    warnOnce(`${api}() ran with no owner (at module scope, after an await or in a timer), so nothing ever stops it: it lives until the page goes. Call it in a component's script, or inside root() and call its dispose when done.\n${sourceStart(named)}`)
}
