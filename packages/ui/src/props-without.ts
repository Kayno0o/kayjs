// The props a component did not name, getters kept, so they stay live when the component reads the rest of its props through one name.
export function without(props: object, ...keys: string[]): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(props)

  for (const key of keys)
    delete descriptors[key]

  return Object.defineProperties({}, descriptors)
}
