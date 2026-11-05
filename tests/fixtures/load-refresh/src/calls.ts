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

// Throws a 403 for a page nobody owns: no `ctx` and no `throw` at the call site.
export async function mustOwn(id: string): Promise<string> {
  await Promise.resolve()

  throw Object.assign(new Error(`not the owner of ${id}`), { status: 403 })
}
