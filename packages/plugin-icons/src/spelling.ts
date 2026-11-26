// A word this long or more is completed or respelled; shorter ones match too much.
const SHORTEST_COMPLETED = 3
const SHORTEST_RESPELLED = 4
// From this length a word may be two edits off, else one.
const TWO_EDITS_FROM = 8
export const MOST = 3

// Every known word starting with `word`, unsorted.
export function completions(word: string, vocabulary: Iterable<string>): string[] {
  if (word.length < SHORTEST_COMPLETED)
    return []

  const found: string[] = []

  for (const candidate of vocabulary) {
    if (candidate.startsWith(word))
      found.push(candidate)
  }

  return found
}

// Every known word one edit from `word` (two for a long one), a swap of neighbour letters counting as one, with its edits, unsorted.
export function respellings(word: string, vocabulary: Iterable<string>): [string, number][] {
  if (word.length < SHORTEST_RESPELLED)
    return []

  const most = word.length >= TWO_EDITS_FROM ? 2 : 1
  const found: [string, number][] = []

  for (const candidate of vocabulary) {
    if (Math.abs(candidate.length - word.length) > most)
      continue

    const edits = distance(word, candidate, most)

    if (edits <= most)
      found.push([candidate, edits])
  }

  return found
}

// The known words closest to `word`, as `respellings` finds them, the closest first.
export function closeWords(word: string, vocabulary: Iterable<string>): string[] {
  return respellings(word, vocabulary).sort((a, b) => a[1] - b[1]).slice(0, MOST).map(([candidate]) => candidate)
}

// Three rows reused by every distance, as one is measured against each of some 25,000 words per typed word.
let rows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)]

// Damerau-Levenshtein distance (optimal string alignment), giving up past `most` once a whole row is above it.
export function distance(a: string, b: string, most = Infinity): number {
  if (rows[0]!.length <= b.length)
    rows = [new Int32Array(b.length * 2), new Int32Array(b.length * 2), new Int32Array(b.length * 2)]

  let [before, previous, row] = rows as [Int32Array, Int32Array, Int32Array]

  for (let j = 0; j <= b.length; j++)
    previous[j] = j

  for (let i = 1; i <= a.length; i++) {
    row[0] = i
    let lowest = i

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost)

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, before[j - 2]! + 1)

      row[j] = value
      lowest = Math.min(lowest, value)
    }

    if (lowest > most)
      return lowest

    ;[before, previous, row] = [previous, row, before]
  }

  return previous[b.length]!
}
