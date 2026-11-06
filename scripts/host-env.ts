const KEY = /^[A-Z_][A-Z0-9_]*$/

// The `KEY=value` lines of a host's settings file, blank lines and `#` comments skipped; a missing file sets nothing.
export async function hostEnv(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path)

  if (!await file.exists())
    return {}

  const env: Record<string, string> = {}

  for (const line of (await file.text()).split('\n')) {
    const equals = line.indexOf('=')
    const key = line.slice(0, equals).trim()

    if (equals > 0 && KEY.test(key))
      env[key] = line.slice(equals + 1).trim()
  }

  return env
}
