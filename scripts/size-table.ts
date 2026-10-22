export interface Size { gzip: number, files: number }

export interface Row { page: string, was: number, now: number, delta: number, grew: boolean, shrank: boolean }

// The bytes a page may differ from its baseline by before it counts as changed: the same build measures up to about a dozen bytes apart between hosts and checkout paths, as the hashed chunk names in the import statements gzip differently.
export const TOLERANCE = 100

export function compare(baseline: Record<string, Size>, sizes: Record<string, Size>): Row[] {
  return Object.entries(sizes).map(([page, { gzip }]) => {
    const was = baseline[page]?.gzip ?? 0
    const delta = gzip - was

    return { page, was, now: gzip, delta, grew: delta > TOLERANCE, shrank: -delta > TOLERANCE }
  })
}

function mark(grew: boolean, shrank: boolean): string {
  if (grew)
    return ' GREW'

  return shrank ? ' shrank' : ''
}

export function table(rows: Row[]): string {
  return [
    ['page'.padEnd(16), 'baseline'.padStart(9), 'now'.padStart(9), 'delta'.padStart(7)].join(' '),
    ...rows.map(({ page, was, now, delta, grew, shrank }) => [page.padEnd(16), String(was).padStart(9), String(now).padStart(9), `${delta > 0 ? '+' : ''}${delta}`.padStart(7), mark(grew, shrank)].join(' ')),
  ].join('\n')
}

// The failure message of the pages that grew, naming each, its delta and the command accepting it; undefined when none did.
export function growth(rows: Row[]): string | undefined {
  const grown = rows.filter(row => row.grew)

  if (grown.length === 0)
    return undefined

  return `Eager JS grew past ${TOLERANCE} B: ${grown.map(({ page, delta }) => `${page} +${delta} B`).join(', ')}. If the growth is intended, run \`bun scripts/sizes.ts --update\` and commit bench/sizes.json with the change.`
}
