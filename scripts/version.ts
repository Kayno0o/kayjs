import process from 'node:process'
import { $, Glob } from 'bun'
import { brokenLinks } from './links'
import { ARCHIVES, INDEX, MAX_PAGE_BYTES, oversizedPages, releasePages, WHATS_NEW } from './whats-new'

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

const texts = await Promise.all(manifests.map(async path => ({ path, text: await Bun.file(path).text() })))
const missing = texts.filter(({ path, text }) => !VERSION.test(text) || (path !== 'package.json' && path !== EXTENSION && !KAY_PEER.test(text))).map(({ path }) => path)

if (missing.length > 0)
  throw new Error(`${missing.join(', ')}: no version or no peer on kay to move`)

// What the release adds goes under its version, where the release notes read it, and the pages an agent reads whole stay short: their oldest releases move to the archive beside them. Computed first, so a link the move or the trim leaves dangling stops the release before it changes anything.
const pageTexts = new Map(await Promise.all([...new Set([INDEX, ...WHATS_NEW, ...ARCHIVES.flat()])].map(async path => [path, await Bun.file(path).text()] as const)))
const pages = releasePages(path => pageTexts.get(path)!, version)
const dangling = await brokenLinks(pages)

if (dangling.length > 0)
  throw new Error(`the release leaves ${dangling.length} broken link${dangling.length === 1 ? '' : 's'}, which tests/docs.test.ts would fail on:\n${dangling.join('\n')}`)

const oversized = oversizedPages(pages)

if (oversized.length > 0)
  throw new Error(`the release leaves ${oversized.join(', ')} over ${MAX_PAGE_BYTES} bytes, which tests/llms.test.ts would fail on: split the release's section into a new file first`)

const start = (await $`git rev-parse HEAD`.text()).trim()
const tag = `v${version}`

// The tree was clean, so a failure anywhere goes back to the commit it started from; the tag, made last, is never left behind.
try {
  await Promise.all(texts.map(async ({ path, text }) => Bun.write(path, text.replace(VERSION, () => `"version": "${version}"`).replace(KAY_PEER, (_, head: string) => `${head}"${peer}"`))))
  await Promise.all([...pages].map(async ([path, text]) => Bun.write(path, text)))
  // bun.lock records each workspace's version and ranges, which the CI's frozen install compares against.
  await $`bun install`.quiet()
  await $`git add bun.lock ${manifests} ${INDEX} ${ARCHIVES.flat()}`
  await $`git commit -q -m ${tag}`
  await $`git tag ${tag}`
}
catch (error) {
  await $`git reset -q --hard ${start}`

  throw error
}

console.log(tag)
