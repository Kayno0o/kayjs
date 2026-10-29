// The candidate nearest to a mistyped name, case aside, when it differs by a letter or two: what an unknown option or config key is answered with.
export function nearest(typed: string, candidates: readonly string[]): string | undefined {
  const lower = typed.toLowerCase()
  const limit = Math.min(2, Math.ceil(typed.length / 3))
  const [near] = candidates.map(candidate => ({ candidate, distance: editDistance(lower, candidate.toLowerCase()) })).filter(({ distance }) => distance <= limit).sort((a, b) => a.distance - b.distance)

  return near?.candidate
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i++) {
    const next = [i]

    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))

    row = next
  }

  return row[b.length]!
}
