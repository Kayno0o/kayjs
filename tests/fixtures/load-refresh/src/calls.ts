export const counts: Record<string, number> = {}

// Runs one load of a fixture page, counting the calls so a test tells which loads a request ran.
export function run<T>(name: string, value: (calls: number) => T): T {
  counts[name] = (counts[name] ?? 0) + 1

  return value(counts[name])
}

export function reset(): void {
  for (const name of Object.keys(counts))
    delete counts[name]
}

export function requireAdmin(ctx: { redirect: (to: string) => never }): never {
  return ctx.redirect('/login')
}
