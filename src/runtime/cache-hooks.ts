// What learns of the keys a render reads and of the keys an invalidation names: the server, one listener each, which a second import replaces.
let readListener: ((key: string) => void) | undefined
let liveListener: ((key: string, tags: readonly string[]) => void) | undefined
let namedListener: ((key: string) => void) | undefined

// Tells the server a render read `key`, a cached value or a collection's entries, so the page it renders is refreshed when `invalidate` drops it.
export function noteRead(key: string): void {
  readListener?.(key)
}

// Tells the server a render read `key` and its page follows it: every open tab shows the page afresh once `invalidate` drops the key, or a tag the value names, even when memory no longer holds the value that knew it.
export function noteLive(key: string, tags: readonly string[] = []): void {
  liveListener?.(key, tags)
}

// Tells the server an `invalidate` names `key`, followed by a page or not, which a call's answer tells the page that made it.
export function noteNamed(key: string): void {
  namedListener?.(key)
}

// Gives back what puts the listener before it back.
export function onRead(listener: (key: string) => void): () => void {
  const previous = readListener

  readListener = listener

  return () => {
    readListener = previous
  }
}

// The server hears each key an `invalidate` names.
export function onKeyNamed(listener: (key: string) => void): void {
  namedListener = listener
}

// The server hears each key read with `live: true`, to make the page that read it follow the key.
export function onLiveRead(listener: (key: string, tags: readonly string[]) => void): void {
  liveListener = listener
}
