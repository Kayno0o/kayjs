const SEPARATOR = /\s*,\s*/

// Whether `file` matches an `accept` attribute (`image/*`, `image/png`, `.svg`), as the native picker filters it; no `accept` takes anything.
// A file whose type the browser could not tell, such as a `.csv` on Windows, is taken against a type token, as only the receiver can read its name's extension the way it serves it.
export function acceptsFile(accept: string | undefined, file: Pick<File, 'name' | 'type'>): boolean {
  const tokens = accept?.trim().toLowerCase().split(SEPARATOR).filter(Boolean) ?? []

  if (tokens.length === 0)
    return true

  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()

  return tokens.some((token) => {
    if (token.startsWith('.'))
      return name.endsWith(token)

    if (type === '')
      return true

    return token.endsWith('/*') ? type.startsWith(token.slice(0, -1)) : type === token
  })
}
