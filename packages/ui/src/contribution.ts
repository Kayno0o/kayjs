import { formatMonthShort } from '@kaynooo/utils/date'

// One day of a ContributionGraph.
export interface ContributionDay {
  // Its ISO date, `2026-09-15`.
  day: string
  // How full its cell is, from 0 to 1.
  intensity: number
  // Hover text for the day, which the date follows.
  description?: string
}

// Columns a month label needs before the next one, so a sliver of a month at the start does not crowd its neighbour.
const LABEL_COLUMNS = 3

// The week column each month starts in, named, dropping a label with too few columns before the next.
export function monthStarts(days: readonly string[]): { column: number, label: string }[] {
  const starts: { column: number, label: string }[] = []
  let month = ''

  for (const [index, day] of days.entries()) {
    if (day.slice(0, 7) === month)
      continue

    month = day.slice(0, 7)
    starts.push({ column: Math.floor(index / 7), label: formatMonthShort(new Date(`${day}T00:00:00`)) })
  }

  return starts.filter((start, index) => (starts[index + 1]?.column ?? Infinity) - start.column >= LABEL_COLUMNS)
}
