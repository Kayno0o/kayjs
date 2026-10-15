import process from 'node:process'
import { $, Glob } from 'bun'
import { stampUnreleased, WHATS_NEW } from './whats-new'

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
const manifests = ['package.json', ...libraries]

const texts = await Promise.all(manifests.map(async path => ({ path, text: await Bun.file(path).text() })))
const missing = texts.filter(({ path, text }) => !VERSION.test(text) || (path !== 'package.json' && !KAY_PEER.test(text))).map(({ path }) => path)

if (missing.length > 0)
  throw new Error(`${missing.join(', ')}: no version or no peer on kay to move`)

const start = (await $`git rev-parse HEAD`.text()).trim()
const tag = `v${version}`

// The tree was clean, so a failure anywhere goes back to the commit it started from; the tag, made last, is never left behind.
try {
  await Promise.all(texts.map(async ({ path, text }) => Bun.write(path, text.replace(VERSION, () => `"version": "${version}"`).replace(KAY_PEER, (_, head: string) => `${head}"${peer}"`))))
  // What the release adds goes under its version, where the release notes read it.
  await Promise.all(WHATS_NEW.map(async path => Bun.write(path, stampUnreleased(await Bun.file(path).text(), version))))
  // bun.lock records each workspace's version and ranges, which the CI's frozen install compares against.
  await $`bun install`.quiet()
  await $`git add bun.lock ${manifests} ${WHATS_NEW}`
  await $`git commit -q -m ${tag}`
  await $`git tag ${tag}`
}
catch (error) {
  await $`git reset -q --hard ${start}`

  throw error
}

console.log(tag)
