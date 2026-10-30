import { join } from 'node:path'
import process from 'node:process'
import { renderMarkdown } from '../src/content/markdown'
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
// The size the newest minor of Upgrading is kept to, the `###` subsections past it moving to the archive as "continued".
export const UPGRADING_CAP = 20_000
// The size past which `just land` asks for the cap: the 3,000 bytes under the wall leave a batch room for its own lines.
const CAP_DUE = 22_000
// The size an archive is kept under by dropping its oldest releases: it only changes at a release, so it needs no room for the next one.
const ARCHIVE_LIMIT = 24_000

// The files whose links to a moved anchor follow it, by glob from the repo root.
export const LINKING = ['llms/*.md', 'llms.txt', 'packages/*/llms.txt', 'packages/*/llms/*.md', 'docs/src/content/docs/**/*.md']

const SECTION = /^(?=## )/m
const BEFORE = /before \d+\.\d+(?:\.\d+)?/
const NOTE = /\n\n(Releases before [^\n]*)\n$/
const PATCH_ZERO = /\.0$/
const VERSION_HEADING = /^## (\d+\.\d+(?:\.\d+)?)/
// The line a capped release ends on, which means nothing once the release is in the archive beside its own continuation.
const POINTER = /\n*The rest of this release is in [^\n]*\n/
const FENCE = /^\s*(?:```|~~~)/
const CONTINUED = /^## [^\n]* \(continued\)\n/
const NOTE_LINK = /\[[^\]]*\]\([^)]*\)/

const UNRELEASED = /^## Unreleased$/m
// The heading stamped at a release, which names a section left over from a cut too.
const UNRELEASED_HEADING = /^## Unreleased(?=$| \(continued\)$)/m
// The last line of an archive whose oldest releases were dropped.
const RELEASES_NOTE = 'Releases before 0.0 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.'

// A minor release is named by its minor, a patch one by its full version, so the line reads back to the release it stops at.
const boundaryVersion = (version: string) => version.replace(PATCH_ZERO, '')

// Names the `## Unreleased` section after the version being released, and the `## Unreleased (continued)` an archive holds for it; a page without one is left as it is.
export function stampUnreleased(text: string, version: string): string {
  return text.replace(UNRELEASED_HEADING, `## ${version}`)
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
  // What a cut of the newest release left at the top of the archive stays above the releases moved beside it.
  const newest = releases.find(section => VERSION_HEADING.test(section)) ?? ''
  const continued = `${newest.includes('\n') ? newest.slice(0, newest.indexOf('\n')) : newest} (continued)\n`
  const own = archived.findIndex(section => !section.startsWith(continued))
  const ownSections = archived.splice(0, own === -1 ? archived.length : own)
  const boundary = (text: string) => text.replace(BEFORE, `before ${boundaryVersion(oldestKept)}`)

  return {
    page: `${[intro, ...releases].join('').trimEnd()}\n\n${boundary(note)}\n`,
    archive: `${boundary(archiveIntro!)}${ownSections.join('')}${moved.map(section => `${section.trimEnd()}\n\n`).join('')}${archived.join('')}`,
  }
}

// Where each top-level bullet (or, with `unit`, each line starting with it) of a section starts, a line inside a fenced code block not being one.
function bulletStarts(section: string, unit = '- '): number[] {
  const starts: number[] = []
  let fenced = false
  let at = 0

  for (const line of section.split('\n')) {
    if (FENCE.test(line))
      fenced = !fenced
    else if (!fenced && line.startsWith(unit))
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

// Cuts the section of a page whose heading `pick` matches to `cap` bytes at a bullet, moving its remaining lines under `<heading> (continued)` at the top of the archive, after what a former cut of the same section left there, and ending the kept ones on a link to it, so the page keeps room for the next lines and nothing is lost. A section already under `cap` is left as it is.
function capSection(page: string, archive: string, cap: number, pick: RegExp, unit = '- '): { page: string, archive: string } {
  const [intro, ...sections] = page.split(SECTION)
  const index = sections.findIndex(section => pick.test(section))
  const note = sections.at(-1)?.match(NOTE)?.[1]
  const link = NOTE_LINK.exec(note ?? '')?.[0]
  // The page's last line belongs to the last section's text, so it is set aside and put back after it.
  const section = index === sections.length - 1 && note !== undefined ? sections[index]?.replace(`\n${note}\n`, '') : sections[index]

  if (section === undefined || link === undefined || Buffer.byteLength(section) <= cap)
    return { page, archive }

  const pointer = `The rest of this release is in ${link}.\n`
  const heading = section.slice(0, section.indexOf('\n'))
  // A section cut before ends on its pointer, which is written again below the lines kept now.
  const body = `${section.replace(POINTER, '\n').trimEnd()}\n`
  const starts = bulletStarts(body, unit)
  const cut = starts.findLast(start => Buffer.byteLength(`${body.slice(0, start).trimEnd()}\n\n${pointer}\n`) <= cap)

  // A section whose first unit alone outgrows the cap has nowhere to be cut.
  if (cut === undefined || cut === starts[0])
    return { page, archive }

  const [archiveIntro, ...archived] = archive.split(SECTION)
  const continued = `${heading} (continued)`
  const former = archived[0]?.startsWith(`${continued}\n`) ? archived.shift()!.slice(continued.length).trim() : ''
  const kept = `${body.slice(0, cut).trimEnd()}\n\n${pointer}${index === sections.length - 1 ? `\n${note}\n` : '\n'}`
  const rest = `${continued}\n\n${former === '' ? '' : `${former}\n\n`}${body.slice(cut).trimEnd()}\n\n`

  return {
    page: [intro, ...sections.map((value, position) => position === index ? kept : value)].join(''),
    archive: `${archiveIntro!}${rest}${archived.join('')}`,
  }
}

// Cuts the newest release of a page to `cap` bytes at a bullet, or at a line starting with `unit`, its remaining lines going under `## <version> (continued)` in the archive.
export const capNewest = (page: string, archive: string, cap = NEWEST_CAP, unit = '- ') => capSection(page, archive, cap, VERSION_HEADING, unit)

// Cuts `## Unreleased` to `cap` bytes between releases the same way, its remaining lines going under `## Unreleased (continued)`, which the release names after its version.
export const capUnreleased = (page: string, archive: string, cap = NEWEST_CAP) => capSection(page, archive, cap, UNRELEASED)

// Drops an archive's oldest releases while it is over `limit` bytes, keeping its newest and, with `keepNewestRelease`, the newest release it holds, which a cap between releases needs as the release just before the unreleased one; and ends it on where the dropped ones are read: each tag's release notes open with its What's new.
export function trimArchive(archive: string, limit = ARCHIVE_LIMIT, keepNewestRelease = false): string {
  const [intro, ...sections] = archive.split(SECTION)
  const last = sections.at(-1)
  const note = last === undefined ? undefined : NOTE.exec(last)?.[1]
  const releases = sections.map(section => note === undefined || section !== last ? section : section.replace(`\n${note}\n`, ''))
  let dropped = false
  // What a cut left at the top of the archive as "(continued)" is no release of its own, so the newest release is the first versioned section after them.
  const floor = keepNewestRelease ? releases.findIndex(section => VERSION_HEADING.test(section) && !CONTINUED.test(section)) + 1 : 0

  while (releases.length > Math.max(floor, 1) && Buffer.byteLength([intro, ...releases, RELEASES_NOTE].join('')) > limit) {
    releases.pop()
    dropped = true
  }

  const oldestKept = VERSION_HEADING.exec(releases.at(-1) ?? '')?.[1]
  // An archive left with only the cut end of an unreleased section holds no version, so every release it listed is dropped: the line starts at the release its opening paragraph stops before.
  const before = oldestKept === undefined ? BEFORE.exec(intro!)?.[0] : `before ${boundaryVersion(oldestKept)}`

  if (!dropped || before === undefined)
    return archive

  return `${[intro, ...releases].join('').trimEnd()}\n\n${RELEASES_NOTE.replace(BEFORE, before)}\n`
}

// The heading ids of a Markdown text.
const headingIds = async (markdown: string) => new Set((await renderMarkdown(markdown)).headings.map(heading => heading.id))

// Points a link to an anchor a cap moved from `page` to its archive at the archive itself, without the anchor: the link check refuses an anchor into an archive, whose sections are dropped at a release. A link is the file as written from llms/, a library or another folder (`upgrading.md`, `./upgrading.md`, `../llms/upgrading.md`), or the page of the site (`/guides/upgrading`). `texts` holds the pages by path from the repo root and the result only those it rewrote.
export async function relinkMoved(texts: ReadonlyMap<string, string>, page: string, before: string, after: string, archive: string): Promise<Map<string, string>> {
  const [wasThere, stays] = await Promise.all([headingIds(before), headingIds(after)])
  const moved = new Set([...wasThere].filter(id => !stays.has(id)))
  const rewritten = new Map<string, string>()

  if (moved.size === 0)
    return rewritten

  const file = page.slice(page.lastIndexOf('/') + 1)
  const name = file.slice(0, -'.md'.length)
  const archiveName = archive.slice(archive.lastIndexOf('/') + 1, -'.md'.length)
  const link = new RegExp(String.raw`\]\(((?:\.{1,2}\/)*(?:llms\/)?${name}\.md|\/(?:guides|llms)\/${name})#([\w-]+)\)`, 'g')

  for (const [path, text] of texts) {
    const next = text.replace(link, (whole, target: string, id: string) => moved.has(id) ? `](${target.replace(new RegExp(`${name}(\\.md)?$`), `${archiveName}$1`)})` : whole)

    if (next !== text)
      rewritten.set(path, next)
  }

  return rewritten
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

// The text of every page a release rewrites, by path: the unreleased section named after `version`, then the oldest releases moved to each archive, each archive trimmed and the index's line for it moved to the release it now starts before. Every page of `linking` that links an anchor the move or the cut takes to an archive follows it, as `--cap` does, and is part of the result. Pure, so a release can check the result before it writes any of it.
export async function releasePages(read: (path: string) => string, version: string, linking: readonly string[] = []): Promise<Map<string, string>> {
  const pages = new Map<string, string>()
  let index = read(INDEX)

  for (const path of WHATS_NEW)
    pages.set(path, stampUnreleased(read(path), version))

  for (const [page, archive] of ARCHIVES) {
    const limit = WHATS_NEW.includes(page) ? WHATS_NEW_LIMIT : PAGE_LIMIT
    const whatsNew = WHATS_NEW.includes(page)
    const before = pages.get(page) ?? read(page)
    const moved = archiveOldest(before, whatsNew ? stampUnreleased(read(archive), version) : read(archive), limit)
    const capped = whatsNew ? capNewest(moved.page, moved.archive) : capNewest(moved.page, moved.archive, UPGRADING_CAP, '### ')
    const newest = whatsNew ? newestRelease(capped.page) : undefined

    if (newest !== undefined && Buffer.byteLength(newest) > NEWEST_CAP)
      throw new Error(`${page}: the newest release is ${Buffer.byteLength(newest)} bytes and stays over its ${NEWEST_CAP} cap: it needs a link to its archive on the last line, and a bullet short enough to cut at`)

    pages.set(page, capped.page)
    pages.set(archive, trimArchive(capped.archive))
    index = indexArchive(index, archive, trimArchive(capped.archive))

    const texts = new Map(linking.map(path => [path, pages.get(path) ?? read(path)] as const))

    texts.set(page, capped.page)
    texts.set(archive, pages.get(archive)!)
    texts.set(INDEX, index)

    for (const [path, text] of await relinkMoved(texts, page, before, capped.page, archive)) {
      if (path === INDEX)
        index = text
      else
        pages.set(path, text)
    }
  }

  pages.set(INDEX, index)

  return pages
}

// Runs the tests a release's rewritten pages must keep green, returning their output when one fails: moving and trimming releases can drop a line a test reads, which only a run after the move shows.
export async function failedPageTests(tests: readonly string[] = ['tests/llms.test.ts']): Promise<string | undefined> {
  const run = Bun.spawn([process.execPath, 'test', ...tests], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

  return code === 0 ? undefined : `${out}${err}`
}

// Puts a release's tree back to the commit it started from: `git reset --hard` restores the tracked files, and the untracked files the release created (a page split into a new file) go with `git clean`, which leaves ignored files alone. The tree was clean when the release began, so nothing of the user's is among them; it runs at the repo root, so a release started from a subfolder cleans the whole tree.
export async function restoreTree(start: string, cwd = join(import.meta.dir, '..')): Promise<void> {
  for (const args of [['reset', '-q', '--hard', start], ['clean', '-q', '-f', '-d']]) {
    const run = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited])

    if (code !== 0)
      throw new Error(`git ${args[0]} failed: ${err}`)
  }
}

// `bun scripts/whats-new.ts --cap` cuts `## Unreleased` of What's new and the newest minor of Upgrading to their caps, moving their oldest lines to the top of each archive as "continued", whose own oldest releases are dropped to stay under the 25,000 bytes (`--check` only reports, exiting 1, which `just land` runs as it never writes to the branch it lands).
if (import.meta.main) {
  const check = process.argv.includes('--check')

  if (!process.argv.includes('--cap'))
    throw new Error('usage: bun scripts/whats-new.ts --cap [--check]')

  const changed: string[] = []
  const paths = (await Promise.all(LINKING.map(async pattern => Array.fromAsync(new Bun.Glob(pattern).scan('.'))))).flat()
  const texts = new Map<string, string>(await Promise.all(paths.map(async path => [path, await Bun.file(path).text()] as const)))
  const writes = new Map<string, string>()

  for (const [page, archive] of ARCHIVES) {
    const [pageText, archiveText] = [texts.get(page)!, texts.get(archive)!]

    // A landing stops only once a page nears the wall, so the cap runs every few batches rather than on each line added past it.
    if (check && Buffer.byteLength(pageText) <= CAP_DUE)
      continue

    const capped = WHATS_NEW.includes(page) ? capUnreleased(pageText, archiveText) : capNewest(pageText, archiveText, UPGRADING_CAP, '### ')

    if (capped.page === pageText)
      continue

    changed.push(page)
    texts.set(page, capped.page)
    texts.set(archive, trimArchive(capped.archive, ARCHIVE_LIMIT, true))
    writes.set(page, capped.page)
    writes.set(archive, texts.get(archive)!)

    // The lines of a page that link a section the cap moved to its archive, on this page or another, follow it.
    for (const [path, text] of await relinkMoved(texts, page, pageText, capped.page, archive)) {
      texts.set(path, text)
      writes.set(path, text)
    }
  }

  if (check && changed.length > 0) {
    console.error(`${changed.join(', ')} outgrew the room kept for the next lines: run \`bun scripts/whats-new.ts --cap\` and commit the result, then land again`)
    process.exit(1)
  }

  await Promise.all([...writes].map(async ([path, text]) => Bun.write(path, text)))

  if (changed.length > 0)
    console.log(`capped ${changed.join(', ')}`)
}
