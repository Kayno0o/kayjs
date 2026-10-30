import process from 'node:process'
import { $, Glob } from 'bun'
import { BREAKING_FILE, breakingRefused } from './breaking'
import { brokenLinks } from './links'
import { ARCHIVES, failedPageTests, INDEX, LINKING, MAX_PAGE_BYTES, oversizedPages, releasePages, restoreTree, WHATS_NEW } from './whats-new'
import { ZED_MANIFEST, zedReleasable, zedRelease } from './zed-release'

// `bun scripts/version.ts patch|minor|major`: kay and every library under packages/ move to one version, committed as `v<version>` and tagged, as `bun pm version` does for one package.
const LEVELS = ['major', 'minor', 'patch'] as const
const VERSION = /"version": "[^"]+"/
// A library's peer on kay, which names kay by its alias where `workspace:` can only name a workspace by its own name.
const KAY_PEER = /("peerDependencies": \{[^}]*"kay": )"[^"]+"/

const level = LEVELS.indexOf(process.argv[2] as typeof LEVELS[number])

if (level === -1)
  throw new Error(`usage: bun scripts/version.ts ${LEVELS.join('|')}`)

if ((await $`git status --porcelain`.text()).trim() !== '')
  throw new Error('the working tree has changes: commit them first')

const current = ((await Bun.file('package.json').json()) as { version: string }).version
// `bun scripts/api.ts --update --breaking` records the exports a change removed or narrowed, which the release that ships them clears.
const breaking = (await Bun.file(BREAKING_FILE).exists()) ? (await Bun.file(BREAKING_FILE).text()).trim() : ''

if (breakingRefused(LEVELS[level]!, current, breaking))
  throw new Error(`${BREAKING_FILE} lists breaking changes, which this release must not ship:\n${breaking}`)

const parts = current.split('.').map((part, index) => {
  if (index < level)
    return Number(part)

  return index === level ? Number(part) + 1 : 0
})
const version = parts.join('.')
// Any patch of the minor, so an app a patch behind the libraries meets their peer.
const peer = `~${parts[0]}.${parts[1]}.0`
const libraries = await Array.fromAsync(new Glob('packages/*/package.json').scan())
// The editor extension is released at kay's version too, with no peer on kay: the kay it runs is the project's own.
const EXTENSION = 'editors/vscode/package.json'
const manifests = ['package.json', ...libraries, EXTENSION]
const zed = await Bun.file(ZED_MANIFEST).text()

if (!zedReleasable(zed))
  throw new Error(`${ZED_MANIFEST}: no version or rev to move`)

const texts = await Promise.all(manifests.map(async path => ({ path, text: await Bun.file(path).text() })))
const missing = texts.filter(({ path, text }) => !VERSION.test(text) || (path !== 'package.json' && path !== EXTENSION && !KAY_PEER.test(text))).map(({ path }) => path)

if (missing.length > 0)
  throw new Error(`${missing.join(', ')}: no version or no peer on kay to move`)

// What the release adds goes under its version, where the release notes read it, and the pages an agent reads whole stay short: their oldest releases move to the archive beside them. Computed first, so a link the move or the trim leaves dangling stops the release before it changes anything.
const linking = (await Promise.all(LINKING.map(async pattern => Array.fromAsync(new Glob(pattern).scan('.'))))).flat()
const pageTexts = new Map(await Promise.all([...new Set([INDEX, ...WHATS_NEW, ...ARCHIVES.flat(), ...linking])].map(async path => [path, await Bun.file(path).text()] as const)))
const pages = await releasePages(path => pageTexts.get(path)!, version, linking)
const dangling = await brokenLinks(pages)

if (dangling.length > 0)
  throw new Error(`the release leaves ${dangling.length} broken link${dangling.length === 1 ? '' : 's'}, which tests/docs.test.ts would fail on:\n${dangling.join('\n')}`)

const oversized = oversizedPages(pages)

if (oversized.length > 0)
  throw new Error(`the release leaves ${oversized.join(', ')} over ${MAX_PAGE_BYTES} bytes, which tests/llms.test.ts would fail on: split the release's section into a new file first`)

const start = (await $`git rev-parse HEAD`.text()).trim()
const tag = `v${version}`

// The tree was clean, so a failure anywhere goes back to the commit it started from, files the release created included; the tag, made last, is never left behind.
try {
  await Promise.all(texts.map(async ({ path, text }) => Bun.write(path, text.replace(VERSION, () => `"version": "${version}"`).replace(KAY_PEER, (_, head: string) => `${head}"${peer}"`))))
  await Promise.all([...pages].map(async ([path, text]) => Bun.write(path, text)))
  await Bun.write(ZED_MANIFEST, zedRelease(zed, version))

  if (breaking !== '')
    await $`git rm -q -f ${BREAKING_FILE}`

  // bun.lock records each workspace's version and ranges, which the CI's frozen install compares against.
  await $`${process.execPath} install`.quiet()
  // The pages are on disk as the tag will have them: a test reading them that now fails stops the release before the commit and the tag, and the reset below restores the tree.
  const failure = await failedPageTests()

  if (failure !== undefined)
    throw new Error(`tests/llms.test.ts fails on the pages this release writes, so nothing is committed or tagged:\n${failure}`)

  await $`git add bun.lock ${manifests} ${ZED_MANIFEST} ${[...pages.keys()]}`
  await $`git commit -q -m ${tag}`
  await $`git tag ${tag}`
}
catch (error) {
  await restoreTree(start)

  throw error
}

console.log(tag)
