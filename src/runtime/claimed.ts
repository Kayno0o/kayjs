// The container of the island being hydrated, which a control reads the server's markup of its field from.
let host: Node | undefined

export function claimedHost(): Node | undefined {
  return host
}

// Runs `render` with `container` as the host, or none: a client-only component has no server markup.
export function claimedIn<T>(container: Node | undefined, render: () => T): T {
  const previous = host

  host = container

  try {
    return render()
  }
  finally {
    host = previous
  }
}
