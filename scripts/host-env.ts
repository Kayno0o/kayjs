const KEY = /^[A-Z_][A-Z0-9_]*$/
const EXPORT = /^export\s+/
const QUOTED = /^(["'])(.*)\1$/

// The `KEY=value` lines of a host's settings file, as a shell or a .env file writes them (`export` and one pair of quotes dropped), blank lines and `#` comments skipped; a missing file sets nothing.
export async function hostEnv(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path)

  if (!await file.exists())
    return {}

  const env: Record<string, string> = {}

  for (const line of (await file.text()).split('\n')) {
    const equals = line.indexOf('=')
    const key = line.slice(0, equals).trim().replace(EXPORT, '')

    if (equals > 0 && KEY.test(key))
      env[key] = line.slice(equals + 1).trim().replace(QUOTED, '$2')
  }

  return env
}
