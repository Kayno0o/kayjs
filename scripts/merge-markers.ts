// A line a diff adds that is a git conflict marker, left in a file by a rebase resolved by hand.
const MARKER = /^(?:<{7}(?: .*)?|={7}|>{7}(?: .*)?)$/
const HUNK = /^@@ -\S+ \+(\d+)/
const DIFF_B_PREFIX = /^b\//

export interface Marker {
  file: string
  line: number
  text: string
}

// The added marker lines of a `git diff --unified=0` output, with their file and line in the new version.
export function addedMarkers(diff: string): Marker[] {
  const markers: Marker[] = []
  let file = ''
  let line = 0
  let inHunk = false

  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      inHunk = false

      continue
    }

    if (!inHunk && text.startsWith('+++ ')) {
      file = text.slice(4).replace(DIFF_B_PREFIX, '')

      continue
    }

    const hunk = HUNK.exec(text)

    if (hunk) {
      line = Number(hunk[1])

      continue
    }

    if (!text.startsWith('+'))
      continue

    if (MARKER.test(text.slice(1)))
      markers.push({ file, line, text: text.slice(1) })

    line++
  }

  return markers
}
