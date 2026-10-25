// The fields of a manifest naming what is installed, and nothing a test reads of the project itself.
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies', 'overrides', 'resolutions']

function withoutDependencies(manifest: string): string | undefined {
  try {
    const fields = JSON.parse(manifest) as Record<string, unknown>

    for (const field of DEPENDENCY_FIELDS)
      delete fields[field]

    return JSON.stringify(fields)
  }
  catch {
    return undefined
  }
}

// Whether a file changing from `before` to `after` changes the dependencies alone: a lockfile, or a manifest whose other fields stayed as they were. A file added or removed, or one that does not parse, changes more.
export function dependenciesOnly(path: string, before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined)
    return false

  if (path === 'bun.lock' || path.endsWith('/bun.lock'))
    return true

  if (path !== 'package.json' && !path.endsWith('/package.json'))
    return false

  const kept = withoutDependencies(before)

  return kept !== undefined && kept === withoutDependencies(after)
}
