// The page listing what each release adds, which the docs site renders too, keeping what is not released yet under `## Unreleased`.
export const WHATS_NEW = ['llms/whats-new.md']
// The index whose lines list each archive and the release it starts before.
export const INDEX = 'llms.txt'
// Each long page with the archive its oldest releases move to, so an agent still reads either with one command.
export const ARCHIVES = [['llms/whats-new.md', 'llms/whats-new-archive.md'], ['llms/upgrading.md', 'llms/upgrading-archive.md']] as const
// What's new keeps well under the limit above, so the lines of the next release, added under `## Unreleased`, always have room: about 25,000 minus this and the newest release's cap.
export const WHATS_NEW_LIMIT = 14_000
// The size the newest release of What's new is kept to: the lines past it move to the top of the archive as "continued", so a long release never leaves the next `## Unreleased` without room.
export const NEWEST_CAP = 10_000
// The size a page is kept under by moving its oldest releases away, below the 25,000 bytes tests/llms.test.ts allows.
export const PAGE_LIMIT = 20_000
// The size tests/llms.test.ts allows a page under llms/: the newest release stays on its page however large, so the limit above is a target and this one a wall.
export const MAX_PAGE_BYTES = 25_000
// The size an archive is kept under by dropping its oldest releases: it only changes at a release, so it needs no room for the next one.
const ARCHIVE_LIMIT = 24_000

const SECTION = /^(?=## )/m
const BEFORE = /before \d+\.\d+(?:\.\d+)?/
const NOTE = /\n\n(Releases before [^\n]*)\n$/
const PATCH_ZERO = /\.0$/
const VERSION_HEADING = /^## (\d+\.\d+(?:\.\d+)?)/
// The line a capped release ends on, which means nothing once the release is in the archive beside its own continuation.
const POINTER = /\n*The rest of this release is in [^\n]*\n/
const FENCE = /^\s*(?:```|~~~)/
const NOTE_LINK = /\[[^\]]*\]\([^)]*\)/

const UNRELEASED = /^## Unreleased$/m
// The last line of an archive whose oldest releases were dropped.
const RELEASES_NOTE = 'Releases before 0.0 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.'

// A minor release is named by its minor, a patch one by its full version, so the line reads back to the release it stops at.
const boundaryVersion = (version: string) => version.replace(PATCH_ZERO, '')

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

  // The newest release stays, beside `## Unreleased` when the page has one, however far over the limit that leaves it.
  const kept = releases.findIndex(section => VERSION_HEADING.test(section)) + 1

  while (releases.length > Math.max(kept, 1) && Buffer.byteLength([intro, ...releases, note ?? ''].join('')) > limit)
    moved.unshift(releases.pop()!.replace(POINTER, '\n'))

  const oldestKept = VERSION_HEADING.exec(releases.at(-1) ?? '')?.[1]

  if (moved.length === 0 || note === undefined || oldestKept === undefined)
    return { page, archive }

  const [archiveIntro, ...archived] = archive.split(SECTION)
  const boundary = (text: string) => text.replace(BEFORE, `before ${boundaryVersion(oldestKept)}`)

  return {
    page: `${[intro, ...releases].join('').trimEnd()}\n\n${boundary(note)}\n`,
    archive: `${boundary(archiveIntro!)}${moved.map(section => `${section.trimEnd()}\n\n`).join('')}${archived.join('')}`,
  }
}

// Where each top-level bullet of a section starts, a line inside a fenced code block not being one.
function bulletStarts(section: string): number[] {
  const starts: number[] = []
  let fenced = false
  let at = 0

  for (const line of section.split('\n')) {
    if (FENCE.test(line))
      fenced = !fenced
    else if (!fenced && line.startsWith('- '))
      starts.push(at)

    at += line.length + 1
  }

  return starts
}

// The text of the newest release of a page without the line listing its archive, or undefined when it has none.
function newestRelease(page: string): string | undefined {
  const sections = page.split(SECTION).slice(1)
  const index = sections.findIndex(section => VERSION_HEADING.test(section))
  const note = sections.at(-1)?.match(NOTE)?.[1]

  return index === sections.length - 1 && note !== undefined ? sections[index]?.replace(`\n${note}\n`, '') : sections[index]
}

// Cuts the newest release of a page to `cap` bytes at a bullet, moving its remaining lines under `## <version> (continued)` at the top of the archive and ending the kept ones on a link to it, so the page keeps room for the next release's lines and nothing is lost. A release already under `cap` is left as it is.
export function capNewest(page: string, archive: string, cap = NEWEST_CAP): { page: string, archive: string } {
  const [intro, ...sections] = page.split(SECTION)
  const index = sections.findIndex(section => VERSION_HEADING.test(section))
  const note = sections.at(-1)?.match(NOTE)?.[1]
  const link = NOTE_LINK.exec(note ?? '')?.[0]
  // The page's last line belongs to the last section's text, so it is set aside and put back after it.
  const section = index === sections.length - 1 && note !== undefined ? sections[index]?.replace(`\n${note}\n`, '') : sections[index]

  if (section === undefined || link === undefined || Buffer.byteLength(section) <= cap)
    return { page, archive }

  const pointer = `The rest of this release is in ${link}.\n`
  const heading = section.slice(0, section.indexOf('\n'))
  const starts = bulletStarts(section)
  const cut = starts.findLast(start => Buffer.byteLength(`${section.slice(0, start).trimEnd()}\n\n${pointer}`) <= cap)

  // A release whose first bullet alone outgrows the cap has nowhere to be cut.
  if (cut === undefined || cut === starts[0])
    return { page, archive }

  const [archiveIntro, ...archived] = archive.split(SECTION)
  const kept = `${section.slice(0, cut).trimEnd()}\n\n${pointer}${index === sections.length - 1 ? `\n${note}\n` : '\n'}`
  const rest = `${heading} (continued)\n\n${section.slice(cut).trimEnd()}\n\n`

  return {
    page: [intro, ...sections.map((value, position) => position === index ? kept : value)].join(''),
    archive: `${archiveIntro!}${rest}${archived.join('')}`,
  }
}

// Drops an archive's oldest releases while it is over `limit` bytes, keeping its newest, and ends it on where the dropped ones are read: each tag's release notes open with its What's new.
export function trimArchive(archive: string, limit = ARCHIVE_LIMIT): string {
  const [intro, ...sections] = archive.split(SECTION)
  const last = sections.at(-1)
  const note = last === undefined ? undefined : NOTE.exec(last)?.[1]
  const releases = sections.map(section => note === undefined || section !== last ? section : section.replace(`\n${note}\n`, ''))
  let dropped = false

  while (releases.length > 1 && Buffer.byteLength([intro, ...releases, RELEASES_NOTE].join('')) > limit) {
    releases.pop()
    dropped = true
  }

  const oldestKept = VERSION_HEADING.exec(releases.at(-1) ?? '')?.[1]

  if (!dropped || oldestKept === undefined)
    return archive

  return `${[intro, ...releases].join('').trimEnd()}\n\n${RELEASES_NOTE.replace(BEFORE, `before ${boundaryVersion(oldestKept)}`)}\n`
}

// Rewrites the "before" version of the line listing an archive to the one its opening paragraph names, so the index says what the archive holds.
export function indexArchive(index: string, path: string, archive: string): string {
  const boundary = BEFORE.exec(archive.split(SECTION)[0]!)?.[0]

  return boundary === undefined ? index : index.split('\n').map(line => line.includes(`(${path})`) ? line.replace(BEFORE, boundary) : line).join('\n')
}

// The pages under llms/ a release leaves over the 25,000 bytes tests/llms.test.ts allows, which only a single release larger than the room left can cause.
export function oversizedPages(pages: Map<string, string>): string[] {
  return [...pages].filter(([path, text]) => path.startsWith('llms/') && Buffer.byteLength(text) > MAX_PAGE_BYTES).map(([path]) => path)
}

// The text of every page a release rewrites, by path: the unreleased section named after `version`, then the oldest releases moved to each archive, each archive trimmed and the index's line for it moved to the release it now starts before. Pure, so a release can check the result before it writes any of it.
export function releasePages(read: (path: string) => string, version: string): Map<string, string> {
  const pages = new Map<string, string>()
  let index = read(INDEX)

  for (const path of WHATS_NEW)
    pages.set(path, stampUnreleased(read(path), version))

  for (const [page, archive] of ARCHIVES) {
    const limit = WHATS_NEW.includes(page) ? WHATS_NEW_LIMIT : PAGE_LIMIT
    const moved = archiveOldest(pages.get(page) ?? read(page), read(archive), limit)
    const capped = WHATS_NEW.includes(page) ? capNewest(moved.page, moved.archive) : moved
    const newest = WHATS_NEW.includes(page) ? newestRelease(capped.page) : undefined

    if (newest !== undefined && Buffer.byteLength(newest) > NEWEST_CAP)
      throw new Error(`${page}: the newest release is ${Buffer.byteLength(newest)} bytes and stays over its ${NEWEST_CAP} cap: it needs a link to its archive on the last line, and a bullet short enough to cut at`)

    pages.set(page, capped.page)
    pages.set(archive, trimArchive(capped.archive))
    index = indexArchive(index, archive, trimArchive(capped.archive))
  }

  pages.set(INDEX, index)

  return pages
}
