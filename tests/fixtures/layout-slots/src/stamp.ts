// Counts the renders of the pages reading it, so a test tells the one a request made from the one a build did.
let renders = 0

export function stamp(): string {
  return `stamp-${++renders}`
}
