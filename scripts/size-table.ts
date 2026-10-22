export interface Size { gzip: number, files: number }

export interface Row { page: string, was: number, now: number, delta: number, wasFiles: number, nowFiles: number, grew: boolean, shrank: boolean }

// The bytes a page may differ from its baseline by before it counts as changed: the same build measures up to about a dozen bytes apart between hosts and checkout paths, as the hashed chunk names in the import statements gzip differently.
// The file count has no tolerance: every eager file is a request, so one more fails whatever its size.
export const TOLERANCE = 100

export function compare(baseline: Record<string, Size>, sizes: Record<string, Size>): Row[] {
  return Object.entries(sizes).map(([page, { gzip, files }]) => {
    const was = baseline[page]?.gzip ?? 0
    const wasFiles = baseline[page]?.files ?? 0
    const delta = gzip - was

    return { page, was, now: gzip, delta, wasFiles, nowFiles: files, grew: delta > TOLERANCE || files > wasFiles, shrank: -delta > TOLERANCE || files < wasFiles }
  })
}

function mark(grew: boolean, shrank: boolean): string {
  if (grew)
    return ' GREW'

  return shrank ? ' shrank' : ''
}

export function table(rows: Row[]): string {
  return [
    ['page'.padEnd(16), 'baseline'.padStart(9), 'now'.padStart(9), 'delta'.padStart(7), 'files'.padStart(8)].join(' '),
    ...rows.map(({ page, was, now, delta, wasFiles, nowFiles, grew, shrank }) => [page.padEnd(16), String(was).padStart(9), String(now).padStart(9), `${delta > 0 ? '+' : ''}${delta}`.padStart(7), (wasFiles === nowFiles ? String(nowFiles) : `${wasFiles}->${nowFiles}`).padStart(8), mark(grew, shrank)].join(' ')),
  ].join('\n')
}

function growthOf({ delta, wasFiles, nowFiles }: Row): string[] {
  const parts: string[] = []

  if (delta > TOLERANCE)
    parts.push(`+${delta} B`)

  if (nowFiles > wasFiles)
    parts.push(`${wasFiles} -> ${nowFiles} files`)

  return parts
}

// The failure message of the pages that grew in bytes or in files, naming each, its change and the command accepting it; undefined when none did.
export function growth(rows: Row[]): string | undefined {
  const grown = rows.filter(row => row.grew)

  if (grown.length === 0)
    return undefined

  return `Eager JS grew past ${TOLERANCE} B or gained a file: ${grown.map(row => `${row.page} ${growthOf(row).join(', ')}`).join('; ')}. If the growth is intended, run \`bun scripts/sizes.ts --update\` and commit bench/sizes.json with the change.`
}
