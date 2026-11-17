type Outputs = Record<string, { imports: { kind: string, path: string }[] }>

// A component's chunk by its key; two files that hash to one key would load each other's code, so that is refused.
export function noteLazy(manifest: { lazies?: Record<string, string[]> | undefined }, key: string, file: string, chunks: string[]): void {
  const lazies = manifest.lazies ??= {}

  if (lazies[key] !== undefined && lazies[key].join() !== chunks.join())
    throw new Error(`${file} and another component share the lazy key ${key}: rename one of the files`)

  lazies[key] = chunks
}

// Every chunk a chunk needs before it can run, itself included.
export function staticClosure(outputs: Outputs, output: string, seen = new Set<string>()): Set<string> {
  if (seen.has(output))
    return seen

  seen.add(output)
  for (const imported of outputs[output]?.imports ?? []) {
    if (imported.kind === 'import-statement')
      staticClosure(outputs, imported.path, seen)
  }

  return seen
}

type Entries = Record<string, { entryPoint?: string | undefined, inputs?: Record<string, { bytesInOutput?: number | undefined }> | undefined }>

// What the lazy runtime and a request cost a page, minified: the lazy chunks of a build holding less than this between them leave a page heavier than the code they keep off it.
const LAZY_PAYOFF = 6000

// The keys of the lazy components that do not pay: a chunk that is only a stub, its code sitting in chunks the islands load up front, or all of them when the chunks with code of their own weigh less than `LAZY_PAYOFF` together. The build runs again with these imports eager.
export function stubKeys(outputs: Entries, keyOf: (entryPoint: string) => string | undefined): string[] {
  const stubs: string[] = []
  const held: string[] = []
  let bytes = 0

  for (const meta of Object.values(outputs)) {
    const key = meta.entryPoint === undefined ? undefined : keyOf(meta.entryPoint)

    if (key === undefined)
      continue

    const own = Object.values(meta.inputs ?? {}).reduce((sum, input) => sum + (input.bytesInOutput ?? 0), 0)

    if (own === 0) {
      stubs.push(key)
    }
    else {
      held.push(key)
      bytes += own
    }
  }

  return bytes < LAZY_PAYOFF ? [...stubs, ...held] : stubs
}
