type Namer = () => string | undefined | Promise<string | undefined>

const namers = new WeakMap<Request, Namer[]>()

// For a library that knows who is signed in: names the request's user, such as their id, read only when another library asks through `userOf`. Call it where the library first sees the request, once per request.
export function nameUser(request: Request, name: Namer): void {
  const list = namers.get(request)

  if (list)
    list.push(name)
  else
    namers.set(request, [name])
}

// Who the libraries named the user of `request`, if any did and one is signed in; the first to name one wins. The name is whatever the library chose, so use it only as a key, not to show.
export async function userOf(request: Request): Promise<string | undefined> {
  for (const name of namers.get(request) ?? []) {
    const user = await name()

    if (typeof user === 'string' && user !== '')
      return user
  }

  return undefined
}
