const SEPARATOR = /\s*,\s*/

// Whether `file` matches an `accept` attribute (`image/*`, `image/png`, `.svg`), as the native picker filters it; no `accept` takes anything.
export function acceptsFile(accept: string | undefined, file: Pick<File, 'name' | 'type'>): boolean {
  const tokens = accept?.trim().toLowerCase().split(SEPARATOR).filter(Boolean) ?? []

  if (tokens.length === 0)
    return true

  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()

  return tokens.some((token) => {
    if (token.startsWith('.'))
      return name.endsWith(token)

    if (token.endsWith('/*'))
      return type.startsWith(token.slice(0, -1))

    return type === token
  })
}
