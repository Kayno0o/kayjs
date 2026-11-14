// What a feature key set to `true` comes to: its defaults, the same as leaving it out, so `false` is the only value a reader tells apart from an absent key.
export function switchOf<Value>(value: Value | boolean | undefined): Exclude<Value, boolean> | false | undefined {
  return value === true ? undefined : value as Exclude<Value, boolean> | false | undefined
}

// The options of a feature key: its bag, or nothing for a key left out, `true` or `false`.
export function bagOf<Bag extends object>(value: Bag | boolean | undefined): Bag | undefined {
  return typeof value === 'object' ? value : undefined
}
