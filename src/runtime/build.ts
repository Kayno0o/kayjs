let loaded: Promise<typeof import('./stale')> | undefined

async function stale(): Promise<typeof import('./stale')> {
  return loaded ??= import('./stale')
}

// Loads what a page does about a deploy while its build still serves it: once a deploy dropped the chunks, this one would be gone with them.
export async function warm(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    try {
      await stale()
    }
    catch {}
  }
}

// What a page of a build the server replaced does about it, in a chunk of its own: given the response that showed it, whether the page is reloading; given none, whether a chunk it failed to load was dropped by a deploy, which reloads it.
export async function skew(response?: Response): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production' || typeof document === 'undefined')
    return false

  try {
    const { noticed, reloadIfStale } = await stale()

    return response ? noticed(response) : await reloadIfStale()
  }
  catch {
    return false
  }
}
