// A promise per request that a test settles when it wants, so it decides when each streamed block of a fixture page arrives.
interface Gate {
  promise: Promise<string>
  resolve: (value: string) => void
  reject: (error: Error) => void
}

const latest = new Map<string, Gate>()

export const hits: Record<string, number> = {}

// Called by the page for each request: the block waits on what the test does with the gate of that name.
export function gate(name: string): Promise<string> {
  hits[name] = (hits[name] ?? 0) + 1

  const made = {} as Gate

  made.promise = new Promise((resolve, reject) => {
    made.resolve = resolve
    made.reject = reject
  })
  latest.set(name, made)

  // A gate a test never settles, or settles after the page left, must not crash the process.
  void ignored(made.promise)

  return made.promise
}

async function ignored(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  }
  catch {}
}

export function release(name: string, value: string): void {
  latest.get(name)?.resolve(value)
}

export function fail(name: string): void {
  latest.get(name)?.reject(new Error(`${name} failed`))
}

export function reset(): void {
  latest.clear()

  for (const name of Object.keys(hits))
    delete hits[name]
}
