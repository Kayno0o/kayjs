// The keys a call's answer names, URL-encoded JSON; one that does not read as a list of texts names none.
export function invalidatedKeys(text: string): string[] | undefined {
  try {
    const keys: unknown = JSON.parse(decodeURIComponent(text))

    return Array.isArray(keys) && keys.every(key => typeof key === 'string') ? keys : undefined
  }
  catch {
    return undefined
  }
}
