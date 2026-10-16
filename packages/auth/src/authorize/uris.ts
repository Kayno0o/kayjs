const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const REDIRECT_URI_MAX_LENGTH = 2048

function loopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

// A redirect URI an app may be registered with: https, or http on the machine itself for a native app's listener; never a fragment or a login in it.
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > REDIRECT_URI_MAX_LENGTH)
    return false

  let url: URL

  try {
    url = new URL(value)
  }
  catch {
    return false
  }

  if (url.hash !== '' || value.includes('#') || url.username !== '' || url.password !== '')
    return false

  return url.protocol === 'https:' ? url.hostname !== '' : loopback(url)
}

// Whether `given` is one of the registered URIs: the same text, or for a listener on the machine itself the same URI whatever its port, as a native app picks a free one.
export function redirectUriRegistered(registered: readonly string[], given: string): boolean {
  if (registered.includes(given))
    return true

  let wanted: URL

  try {
    wanted = new URL(given)
  }
  catch {
    return false
  }

  if (!loopback(wanted))
    return false

  return registered.some((each) => {
    try {
      const url = new URL(each)

      return loopback(url) && url.hostname === wanted.hostname && url.pathname === wanted.pathname && url.search === wanted.search
    }
    catch {
      return false
    }
  })
}

// `base` with the query given, an existing one kept: how an authorization response reaches the client.
export function withParams(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base)

  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined)
      url.searchParams.set(name, value)
  }

  return url.href
}
