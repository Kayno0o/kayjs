// `index` moved by `delta` around `count` places, wrapping at both ends.
export function stepIndex(index: number, delta: number, count: number): number {
  return count === 0 ? 0 : (((index + delta) % count) + count) % count
}
