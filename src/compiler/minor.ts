const MINOR = /^(\d+)\.(\d+)(?:\.\d+)?$/

// The minor, as `[major, minor]`, a version or a `1.46` names, or undefined for what is neither.
export function minorOf(version: string): [number, number] | undefined {
  const found = MINOR.exec(version)

  return found === null ? undefined : [Number(found[1]), Number(found[2])]
}

// Whether the minor `a` comes after `b`.
export function minorAfter(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] ? a[1] > b[1] : a[0] > b[0]
}
