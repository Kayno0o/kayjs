// The page listing what each release adds, which the docs site renders too, keeping what is not released yet under `## Unreleased`.
export const WHATS_NEW = ['llms/whats-new.md']
// Each long page with the archive its oldest releases move to, so an agent still reads either with one command.
export const ARCHIVES = [['llms/whats-new.md', 'llms/whats-new-archive.md'], ['llms/upgrading.md', 'llms/upgrading-archive.md']] as const
// The size a page is kept under by moving its oldest releases away, below the 25,000 bytes tests/llms.test.ts allows.
export const PAGE_LIMIT = 20_000

const SECTION = /^(?=## )/m
const BEFORE = /before \d+\.\d+/
const NOTE = /\n\n(Releases before [^\n]*)\n$/
const VERSION_HEADING = /^## (\d+\.\d+)/

const UNRELEASED = /^## Unreleased$/m

// Names the `## Unreleased` section after the version being released; a page without one is left as it is.
export function stampUnreleased(text: string, version: string): string {
  return text.replace(UNRELEASED, `## ${version}`)
}

// Moves the oldest releases of a page to the top of its archive while the page is over `limit` bytes, keeping its newest release, and moves the "before" version of the page's last line and the archive's intro up with them.
export function archiveOldest(page: string, archive: string, limit = PAGE_LIMIT): { page: string, archive: string } {
  const [intro, ...sections] = page.split(SECTION)
  const last = sections.at(-1)
  const note = last === undefined ? undefined : NOTE.exec(last)?.[1]
  const releases = sections.map(section => note === undefined || section !== last ? section : section.replace(`\n${note}\n`, ''))
  const moved: string[] = []

  while (releases.length > 1 && Buffer.byteLength([intro, ...releases, note ?? ''].join('')) > limit)
    moved.unshift(releases.pop()!)

  const oldestKept = VERSION_HEADING.exec(releases.at(-1) ?? '')?.[1]

  if (moved.length === 0 || note === undefined || oldestKept === undefined)
    return { page, archive }

  const [archiveIntro, ...archived] = archive.split(SECTION)
  const boundary = (text: string) => text.replace(BEFORE, `before ${oldestKept}`)

  return {
    page: `${[intro, ...releases].join('').trimEnd()}\n\n${boundary(note)}\n`,
    archive: `${boundary(archiveIntro!)}${moved.map(section => `${section.trimEnd()}\n\n`).join('')}${archived.join('')}`,
  }
}
