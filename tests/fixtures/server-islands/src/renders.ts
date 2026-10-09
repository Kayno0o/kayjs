// Counts what renders, so a test tells what a request rendered.
export const renders = { hero: 0, stamps: 0 }

export function stamp(): string {
  return `stamp-${++renders.stamps}`
}
