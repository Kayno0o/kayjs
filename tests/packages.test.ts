import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { archiveOldest, capNewest, indexArchive, MAX_PAGE_BYTES, NEWEST_CAP, oversizedPages, releasePages, stampUnreleased, trimArchive } from '../scripts/whats-new'

interface Manifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: { bun?: string }
}

const root = await Bun.file('package.json').json() as Manifest
const libraries = await Promise.all((await Array.fromAsync(new Glob('packages/*/package.json').scan())).sort().map(async path => ({ path, manifest: await Bun.file(path).json() as Manifest })))
const names = new Set(libraries.map(({ manifest }) => manifest.name))
const [major, minor] = root.version.split('.')

// The editor extension ships as a .vsix at kay's version, so the release attaches the one its tag names.
describe('the editor extension', () => {
  it('is at kay\'s version and not private', async () => {
    const extension = await Bun.file('editors/vscode/package.json').json() as Manifest & { private?: boolean }

    expect(extension.version).toBe(root.version)
    expect(extension.private).toBeUndefined()
  })
})

// scripts/version.ts moves kay and its libraries together: a library a version apart, or naming another by a range, would publish the drift the monorepo exists to prevent.
describe('kay\'s libraries', () => {
  it.each(libraries)('$path is at kay\'s version and peers on kay\'s minor', ({ manifest }) => {
    expect(manifest.version).toBe(root.version)
    expect(manifest.peerDependencies?.kay).toBe(`~${major}.${minor}.0`)
  })

  it.each(libraries)('$path names the other libraries as workspaces', ({ manifest }) => {
    const ranges = [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies, manifest.devDependencies].flatMap(field => Object.entries(field ?? {})).filter(([name]) => names.has(name))

    expect(ranges.filter(([, range]) => range !== 'workspace:~')).toEqual([])
  })

  // One install serves the whole workspace: a tool kay and a library both develop with, at two ranges, would have one of them test against a version it does not name.
  it('develop with the ranges kay and the other libraries name for the same dependency', () => {
    const ranges = new Map<string, Set<string>>()

    for (const field of [root.dependencies, root.devDependencies, ...libraries.map(({ manifest }) => manifest.devDependencies)]) {
      for (const [name, range] of Object.entries(field ?? {}).filter(([name]) => !names.has(name)))
        ranges.set(name, (ranges.get(name) ?? new Set()).add(range))
    }

    expect([...ranges].filter(([, named]) => named.size > 1).map(([name, named]) => [name, [...named]])).toEqual([])
  })

  // `kay/pg-orm` is the one module reaching pg-orm, so an app without it installs, builds and runs; the app template and `kay generate resource` only write the import into the files of a new app, and `kay/test/preload` imports it only for a project with a `pg-orm.config.ts`.
  it('asks for pg-orm as an optional peer, imported by kay/pg-orm alone', async () => {
    expect(root.peerDependencies?.['@kaynooo/pg-orm']).toBeDefined()
    expect((root as Manifest & { peerDependenciesMeta: Record<string, unknown> }).peerDependenciesMeta['@kaynooo/pg-orm']).toEqual({ optional: true })
    expect(root.dependencies?.['@kaynooo/pg-orm']).toBeUndefined()

    const importers: string[] = []

    for (const file of await Array.fromAsync(new Glob('src/**/*.{ts,kay}').scan())) {
      if (!['src/new.ts', 'src/templates.ts', 'src/generate-resource.ts'].includes(file) && (/(?:from|import)\s*(?:\(\s*)?['"]@kaynooo\/pg-orm['"]/).test(await Bun.file(file).text()))
        importers.push(file)
    }

    expect(importers.sort()).toEqual(['src/server/pg-orm.ts', 'src/test/database.ts'])
  })

  it.each(libraries)('$path asks for the Bun kay asks for', ({ manifest }) => {
    expect(manifest.engines?.bun).toBe(root.engines!.bun)
  })
})

// scripts/version.ts names What's new's pending section after the release, where the release notes read it.
describe('what\'s new', () => {
  it('names the Unreleased section after the version, and leaves a page without one as it is', () => {
    expect(stampUnreleased('# What\'s new\n\n## Unreleased\n\n- a\n\n## 1.43.0\n\n- b\n', '1.44.0')).toBe('# What\'s new\n\n## 1.44.0\n\n- a\n\n## 1.43.0\n\n- b\n')
    expect(stampUnreleased('# What\'s new\n\nNothing is ## Unreleased here.\n\n### Unreleased\n\n## 1.43.0\n', '1.44.0')).toBe('# What\'s new\n\nNothing is ## Unreleased here.\n\n### Unreleased\n\n## 1.43.0\n')
  })

  it('moves the oldest releases to the archive while the page is over its limit, and the "before" version with them', () => {
    const page = '# New\n\nIntro.\n\n## 1.46.0\n\n- c\n\n## 1.45.0\n\n- bb\n\n## 1.44.0\n\n- aaaaaaaaaa\n\nReleases before 1.44 are in [Old](old.md).\n'
    const archive = '# Old\n\nWhat each release before 1.44 added.\n\n## 1.43.0\n\n- z\n'

    expect(archiveOldest(page, archive, 1000)).toEqual({ page, archive })
    expect(archiveOldest(page, archive, 100)).toEqual({
      page: '# New\n\nIntro.\n\n## 1.46.0\n\n- c\n\n## 1.45.0\n\n- bb\n\nReleases before 1.45 are in [Old](old.md).\n',
      archive: '# Old\n\nWhat each release before 1.45 added.\n\n## 1.44.0\n\n- aaaaaaaaaa\n\n## 1.43.0\n\n- z\n',
    })
    // The newest release stays whatever the limit, and a page without the "before" line is left as it is.
    expect(archiveOldest(page, archive, 1).page).toContain('## 1.46.0')
    expect(archiveOldest(page, archive, 1).page).not.toContain('## 1.45.0')
    expect(archiveOldest(page.replace(/Releases before.*\n/, ''), archive, 1)).toEqual({ page: page.replace(/Releases before.*\n/, ''), archive })
  })

  it('moves the oldest releases while Unreleased alone is over the limit, keeping the newest release, and names a patch boundary in full', () => {
    const page = '# New\n\nIntro.\n\n## Unreleased\n\n- uuuuuuuuuuuuuuuuuuuuuuuu\n\n## 1.51.2\n\n- c\n\n## 1.51.1\n\n- bb\n\n## 1.51.0\n\n- aaaaaaaaaa\n\nReleases before 1.51 are in [Old](old.md).\n'
    const archive = '# Old\n\nWhat each release before 1.51 added.\n\n## 1.50.0\n\n- z\n'
    const moved = archiveOldest(page, archive, 10)

    expect(moved.page).toBe('# New\n\nIntro.\n\n## Unreleased\n\n- uuuuuuuuuuuuuuuuuuuuuuuu\n\n## 1.51.2\n\n- c\n\nReleases before 1.51.2 are in [Old](old.md).\n')
    expect(moved.archive).toBe('# Old\n\nWhat each release before 1.51.2 added.\n\n## 1.51.1\n\n- bb\n\n## 1.51.0\n\n- aaaaaaaaaa\n\n## 1.50.0\n\n- z\n')
    // The patch boundary reads back: a second run moves nothing.
    expect(archiveOldest(moved.page, moved.archive, 10)).toEqual(moved)
  })

  it('lets a release whose own section outgrows the page limit through, moving every older one away, and names a page still over the hard limit', () => {
    const big = `- ${'x'.repeat(21_000)}`
    const page = `# New\n\nIntro.\n\n## 1.70.0\n\n${big}\n\n## 1.69.0\n\n- b\n\nReleases before 1.69 are in [Old](old.md).\n`
    const archive = '# Old\n\nWhat each release before 1.69 added.\n\n## 1.68.0\n\n- z\n'
    const files: Record<string, string> = { 'llms.txt': '- [Old](old.md): before 1.69\n', 'llms/whats-new.md': '# W\n', 'llms/whats-new-archive.md': '# WA\n', 'llms/upgrading.md': page, 'llms/upgrading-archive.md': archive }
    const pages = releasePages(path => files[path]!, '1.70.0')

    expect(pages.get('llms/upgrading.md')).toBe(`# New\n\nIntro.\n\n## 1.70.0\n\n${big}\n\nReleases before 1.70 are in [Old](old.md).\n`)
    expect(pages.get('llms/upgrading-archive.md')).toContain('## 1.69.0\n\n- b')
    expect(oversizedPages(pages)).toEqual([])
    expect(oversizedPages(new Map([['llms/upgrading.md', 'x'.repeat(MAX_PAGE_BYTES + 1)], ['llms.txt', 'x'.repeat(MAX_PAGE_BYTES + 1)], ['llms/a.md', 'x'.repeat(MAX_PAGE_BYTES)]]))).toEqual(['llms/upgrading.md'])
  })

  it('cuts a long newest release at a bullet into the archive, leaving room for the next release\'s lines, and loses none of it', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(letter => letter.repeat(60))
    const page = `# New\n\nIntro.\n\n## 1.70.0\n\n- ${a}\n- ${b}\n  more\n- ${c}\n\nReleases before 1.70 are in [Old](old.md).\n`
    const archive = '# Old\n\nWhat each release before 1.70 added.\n\n## 1.69.0\n\n- z\n'
    const capped = capNewest(page, archive, 200)

    expect(capped.page).toBe(`# New\n\nIntro.\n\n## 1.70.0\n\n- ${a}\n- ${b}\n  more\n\nThe rest of this release is in [Old](old.md).\n\nReleases before 1.70 are in [Old](old.md).\n`)
    expect(capped.archive).toBe(`# Old\n\nWhat each release before 1.70 added.\n\n## 1.70.0 (continued)\n\n- ${c}\n\n## 1.69.0\n\n- z\n`)
    expect(capNewest(page, archive, 1000)).toEqual({ page, archive })
    // A first bullet that alone outgrows the cap has nowhere to be cut.
    expect(capNewest(page, archive, 5)).toEqual({ page, archive })
  })

  it('drops the pointer of a capped release when it moves to the archive beside its continuation', () => {
    const page = '# New\n\nIntro.\n\n## 1.71.0\n\n- n\n\n## 1.70.0\n\n- a\n\nThe rest of this release is in [Old](old.md).\n\nReleases before 1.70 are in [Old](old.md).\n'
    const archive = '# Old\n\nWhat each release before 1.70 added.\n\n## 1.70.0 (continued)\n\n- c\n'
    const moved = archiveOldest(page, archive, 10)

    expect(moved.page).toBe('# New\n\nIntro.\n\n## 1.71.0\n\n- n\n\nReleases before 1.71 are in [Old](old.md).\n')
    expect(moved.archive).toBe('# Old\n\nWhat each release before 1.71 added.\n\n## 1.70.0\n\n- a\n\n## 1.70.0 (continued)\n\n- c\n')
  })

  it('never cuts a release inside a code fence', () => {
    const a = 'a'.repeat(60)
    const c = 'c'.repeat(200)
    const page = `# New\n\nIntro.\n\n## 1.70.0\n\n- ${a}\n  \`\`\`ts\n- not a bullet\n  \`\`\`\n- ${c}\n\nReleases before 1.70 are in [Old](old.md).\n`
    const archive = '# Old\n\nWhat each release before 1.70 added.\n'
    const capped = capNewest(page, archive, 230)

    // The line inside the fence would fit under 140 bytes, and is no place to cut.
    expect(capNewest(page, archive, 140)).toEqual({ page, archive })

    expect(capped.page).toContain('not a bullet')
    expect(capped.page).not.toContain(c)
    expect(capped.archive).toContain(`- ${c}`)
    expect(capped.archive).not.toContain('not a bullet')
  })

  it('refuses a release whose newest What\'s new section cannot be cut under its cap', () => {
    const files: Record<string, string> = {
      'llms.txt': '- [Old](llms/whats-new-archive.md): before 1.69\n- [Up](llms/upgrading-archive.md): before 1.69\n',
      'llms/whats-new.md': `# W\n\n## Unreleased\n\n- ${'x'.repeat(NEWEST_CAP + 1)}\n\nReleases before 1.69 are in [Old](whats-new-archive.md).\n`,
      'llms/whats-new-archive.md': '# WA\n\nWhat each release before 1.69 added.\n',
      'llms/upgrading.md': '# U\n',
      'llms/upgrading-archive.md': '# UA\n\nWhat each release before 1.69 added.\n',
    }

    expect(() => releasePages(path => files[path]!, '1.70.0')).toThrow('stays over its')
    expect(() => releasePages(path => files[path]!.replace('Releases before 1.69 are in [Old](whats-new-archive.md).\n', ''), '1.70.0')).toThrow('stays over its')
  })

  it('keeps What\'s new far enough under the hard limit for a batch of Unreleased lines whatever the newest release weighs', () => {
    const bullets = (count: number) => Array.from({ length: count }, (_, index) => `- ${index} ${'x'.repeat(300)}\n`).join('')
    const files: Record<string, string> = {
      'llms.txt': '- [Old](llms/whats-new-archive.md): before 1.69\n- [Up](llms/upgrading-archive.md): before 1.69\n',
      'llms/whats-new.md': `# W\n\n## Unreleased\n\n${bullets(60)}\n## 1.69.0\n\n${bullets(30)}\nReleases before 1.69 are in [Old](whats-new-archive.md).\n`,
      'llms/whats-new-archive.md': '# WA\n\nWhat each release before 1.69 added.\n\n## 1.68.0\n\n- z\n',
      'llms/upgrading.md': '# U\n',
      'llms/upgrading-archive.md': '# UA\n\nWhat each release before 1.69 added.\n',
    }
    const page = releasePages(path => files[path]!, '1.70.0').get('llms/whats-new.md')!

    expect(Buffer.byteLength(page)).toBeLessThan(NEWEST_CAP + 1000)
    expect(MAX_PAGE_BYTES - Buffer.byteLength(page)).toBeGreaterThan(10_000)
  })

  it('moves the index\'s line for an archive to the release it now starts before, and leaves the other lines alone', () => {
    const archive = '# Old\n\nWhat each release before 1.46 added.\n\n## 1.45.0\n\n- z\n'
    const index = '# Docs\n\n- [New](new.md): what each recent release adds, before 1.1\n- [Old](old.md): the same for the releases before 1.45\n'

    expect(indexArchive(index, 'old.md', archive)).toBe(index.replace('before 1.45', 'before 1.46'))
    expect(indexArchive(index, 'other.md', archive)).toBe(index)
  })

  it('drops the oldest releases of an archive over its limit, keeping its newest, and ends on where they are read', () => {
    const archive = '# Old\n\nWhat each release before 1.47 added.\n\n## 1.46.0\n\n- c\n\n## 1.45.0\n\n- bb\n\n## 1.44.0\n\n- aaaaaaaaaa\n'
    const trimmed = trimArchive(archive, 190)

    expect(trimArchive(archive, 1000)).toBe(archive)
    expect(trimmed).toStartWith('# Old\n\nWhat each release before 1.47 added.\n\n## 1.46.0\n\n- c\n\n## 1.45.0\n\n- bb\n\nReleases before 1.45 are in the notes of their releases')
    expect(trimmed).not.toContain('1.44.0')
    // Trimmed again, it moves its own last line up rather than writing a second one.
    expect(trimArchive(trimmed, 1).match(/Releases before/g)).toEqual(['Releases before'])
    expect(trimArchive(trimmed, 1)).toContain('## 1.46.0\n\n- c\n\nReleases before 1.46')
  })
})

describe('the TypeScript packages', () => {
  it('give kay the native compiler under its own alias and typescript 6 under the name typescript-eslint reads', () => {
    expect(root.dependencies?.typescript7).toStartWith('npm:typescript@')
    expect(root.dependencies?.typescript).toStartWith('^6')
  })

  it('give an app the tsgo command running the native compiler', async () => {
    const run = Bun.spawn(['bun', 'src/tsgo.ts', '--version'], { stdout: 'pipe', stderr: 'pipe' })

    expect(await new Response(run.stdout).text()).toMatch(/^Version 7\./)
    expect(await run.exited).toBe(0)
    expect((root as Manifest & { bin: Record<string, string> }).bin.tsgo).toBe('./src/tsgo.ts')
  })
})

// The naming rules of llms/component-library-conventions.md that a scan can check. A rule whose rename has not landed lists its known drift in `known`, each entry naming the issue that removes it: the test is green today, fails for any new drift, and fails for an entry whose drift is gone, so the entry goes with the fix.
interface Drift { library: string, match: RegExp, issue: string }

const folders = libraries.map(({ path }) => path.slice('packages/'.length, path.lastIndexOf('/')))
const sources = await Promise.all(folders.map(async library => ({
  library,
  files: await Promise.all((await Array.fromAsync(new Glob(`packages/${library}/src/**/*.{ts,kay,css}`).scan())).sort().map(async file => ({ file, text: await Bun.file(file).text() }))),
})))

function drift(find: (library: string, file: string, text: string) => string[], known: Drift[]): string[] {
  const unexpected: string[] = []
  const unused = new Set(known)

  for (const { library, files } of sources) {
    for (const { file, text } of files) {
      for (const found of find(library, file, text)) {
        const excuse = known.find(entry => entry.library === library && entry.match.test(found))

        if (excuse)
          unused.delete(excuse)
        else
          unexpected.push(`${file}: ${found}`)
      }
    }
  }

  return [...unexpected, ...[...unused].map(entry => `known drift of ${entry.issue} is gone, remove ${entry.match} from the list`)]
}

describe('the naming conventions', () => {
  const others = folders.join('|')

  it('prefix a library\'s classes and ids with k<library>-, never kayjs-<library>-', () => {
    expect(drift((_, __, text) => text.match(new RegExp(`(?<![\\w@/.-])kayjs-(?:${others})-[\\w-]*`, 'g')) ?? [], [])).toEqual([])
  })

  it('define a library\'s stylesheet classes under its own k<library>- prefix', () => {
    const find = (library: string, file: string, text: string): string[] => {
      if (!file.endsWith('.css'))
        return []

      const bare = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(["'])(?:(?!\1).)*\1|url\([^)]*\)/g, '')

      // A stylesheet may restyle another library's classes (cms styles kui-form-field), ui's charts are drawn by chartist whose own `ct-` classes the theme styles, and `group` is Tailwind's.
      const foreign = new RegExp(`^k(?:${others})-`)

      return [...bare.matchAll(/(?<![\w)\]-])\.([a-z][\w-]*)/g)].map(([, name]) => name!).filter(name => !foreign.test(name) && !(library === 'ui' && (name.startsWith('ct-') || name === 'group')))
    }

    expect(drift(find, [])).toEqual([])
  })

  it('prefix a library\'s data attributes with data-k<library>-, never data-<library>-', () => {
    const find = (library: string, _: string, text: string): string[] => [
      ...text.match(new RegExp(`data-(?:${others}|kayjs)-[\\w-]*`, 'g')) ?? [],
      ...(text.match(new RegExp(`data-k(?:${others})-[\\w-]*`, 'g')) ?? []).filter(attribute => !attribute.startsWith(`data-k${library}-`)),
    ]

    expect(drift(find, [{ library: 'cms', match: /^data-cms-edit-page$/, issue: '#1691, the name before 1.70 kept three minors' }])).toEqual([])
  })

  it('mount a library\'s internal routes under /_kay/<library>, outside /api', () => {
    const find = (_: string, __: string, text: string): string[] => text.match(/['"`]\/api\/[\w-]+/g) ?? []

    expect(drift(find, [])).toEqual([])
  })

  it('name cookies and tables with kay_, a library\'s own tables included', () => {
    const find = (_: string, __: string, text: string): string[] => [
      ...(text.match(/['"`]k(?!ay_)[a-z]+_[a-z_]+['"`]/g) ?? []),
      ...[...text.matchAll(/defineTable\(\s*['"`]([^'"`]+)['"`]/g)].map(([, table]) => table!).filter(table => !table.startsWith('kay_')),
    ]

    expect(drift(find, [
      { library: 'cms', match: /^.kcms_session.$/, issue: '#1691, the name before 1.70 kept three minors' },
    ])).toEqual([])
  })

  it('end the name of an error class a library exports with Error', () => {
    const find = (_: string, __: string, text: string): string[] => [...text.matchAll(/export (?:abstract )?class (\w+) extends (\w+)/g)].filter(([, name, base]) => base!.endsWith('Error') && !name!.endsWith('Error')).map(([, name]) => name!)

    expect(drift(find, [])).toEqual([])
  })

  it('end the name of an error class kay exports with Error', async () => {
    const found: string[] = []

    for (const file of await Array.fromAsync(new Glob('src/**/*.ts').scan())) {
      for (const [, name, base] of (await Bun.file(file).text()).matchAll(/export (?:abstract )?class (\w+) extends (\w+)/g)) {
        if (base!.endsWith('Error') && !name!.endsWith('Error'))
          found.push(`${file}: ${name}`)
      }
    }

    expect(found).toEqual([])
  })

  it('keep the old name of a renamed error class as a @deprecated alias', async () => {
    for (const [file, name] of [['src/runtime/dom.ts', 'HydrationMismatch'], ['src/runtime/action.ts', 'ActionRedirect'], ['src/server/violations.ts', 'CspViolation'], ['src/server/runtime-redirects.ts', 'RedirectRefused'], ['packages/cms/src/files.ts', 'SaveConflict'], ['packages/mail/src/mailer.ts', 'MailNotConfigured']] as const) {
      const text = await Bun.file(file).text()

      expect(text).toContain(`/** @deprecated Renamed \`${name}Error\``)
      expect(text).toContain(`export const ${name} = ${name}Error\n`)
      expect(text).toContain(`export type ${name} = ${name}Error\n`)
    }
  })

  it('keep the old name of an export renamed to stop clashing across libraries as a @deprecated alias', async () => {
    for (const [file, old, renamed] of [['packages/auth/src/memoryStore.ts', 'memoryStore', 'memoryAuthStore'], ['packages/auth/src/mail.ts', 'Mail', 'AuthMailMessage'], ['packages/auth/src/mail.ts', 'Mailer', 'AuthMailer'], ['packages/mail/src/defaults.ts', 'Settings', 'MailSettings'], ['packages/mail/src/defaults.ts', 'defaults', 'mailDefaults'], ['packages/mail/src/types.ts', 'Field', 'MailField'], ['packages/mail/src/types.ts', 'Message', 'MailMessage'], ['packages/ui/src/defaults.ts', 'Settings', 'UiSettings'], ['packages/ui/src/defaults.ts', 'defaults', 'uiDefaults'], ['packages/cms/src/loaders/postgres.ts', 'postgresLoader', 'pgLoader'], ['packages/cms/src/loaders/postgres.ts', 'PostgresLoaderOptions', 'PgLoaderOptions']] as const) {
      const text = await Bun.file(file).text()

      expect(text).toContain(`/** @deprecated Renamed \`${renamed}\` in 1.70`)
      expect(text).toMatch(new RegExp(`export (?:const|type) ${old}(?:<[^>]*>)? = ${renamed}`))
    }
  })

  it('give the error class a library exports a code, as kay\'s KayError carries one', () => {
    const find = (_: string, __: string, text: string): string[] => [...text.matchAll(/export (?:abstract )?class (\w+) extends \w*Error \{\n([\s\S]*?)\n\}/g)].filter(([, , body]) => !(/\bcode\b/).test(body!)).map(([, name]) => name!)

    expect(drift(find, [])).toEqual([])
  })
})

// Topic files open with the tasks and keep the facts under Reference, for kay and for each library alike.
describe('the llms topic files', () => {
  // The release logs are written by `just patch` and `just minor`, not as a topic.
  const INDEX_BYTES = 6000
  const logs = /^llms\/(?:whats-new|upgrading)(?:-archive)?\.md$/
  const topics = async () => [...await Array.fromAsync(new Glob('llms/*.md').scan()), ...await Array.fromAsync(new Glob('packages/*/llms/*.md').scan())].sort().filter(file => !logs.test(file))

  it('open with Common tasks and hold a Reference section', async () => {
    const lacking: string[] = []

    for (const file of await topics()) {
      const text = await Bun.file(file).text()
      const opens = (/^## Common tasks$/m).test(text) && (/^## Reference$/m).test(text) && text.indexOf('## Common tasks') < text.indexOf('## Reference')

      if (!opens)
        lacking.push(file)
    }

    expect(lacking).toEqual([])
  })

  // A library's llms.txt is a title, a one-line quote and a list of links, like kay's own.
  it('keep each library\'s llms.txt an index without a rules dump', async () => {
    const found: string[] = []

    for (const library of folders) {
      const text = await Bun.file(`packages/${library}/llms.txt`).text()
      const bytes = new TextEncoder().encode(text).length
      const dump = (/^## Rules that are easy to get wrong$/m).test(text)

      if (dump)
        found.push(`${library}: a rules dump, move the rules into the Reference of a topic file`)

      if (bytes > INDEX_BYTES)
        found.push(`${library}: ${bytes} bytes, over the ${INDEX_BYTES} an index may take`)
    }

    expect(found).toEqual([])
  })

  // One lookup and one registration (llms/component-libraries.md, Texts): `wording` from `kay/words`, a shipped `fr.ts` and no `en.ts`, declared by `kay.messages` in package.json.
  it('word every text through wording, with a French catalog registered in package.json', async () => {
    const found: string[] = []

    for (const library of folders) {
      const manifest = await Bun.file(`packages/${library}/package.json`).json() as { kay?: { messages?: string } }
      const sources = await Array.fromAsync(new Glob('src/**/*.{kay,ts}').scan({ cwd: `packages/${library}` }))
      const files = await Promise.all(sources.map(async path => ({ path, text: await Bun.file(`packages/${library}/${path}`).text() })))
      const wording = files.some(({ text }) => (/\bwording\(/).test(text))

      for (const { path, text } of files) {
        if ((/import \{[^}]*\bt\b[^}]*\} from 'kay\/i18n'/).test(text))
          found.push(`${library}: ${path} looks text up with t(), use wording()`)
      }

      if (wording && manifest.kay?.messages === undefined)
        found.push(`${library}: uses wording() but package.json has no kay.messages`)

      if (manifest.kay?.messages !== undefined) {
        const directory = manifest.kay.messages

        if (!(await Bun.file(`packages/${library}/${directory}/fr.ts`).exists()))
          found.push(`${library}: ${directory} ships no fr.ts`)

        if (await Bun.file(`packages/${library}/${directory}/en.ts`).exists())
          found.push(`${library}: ${directory}/en.ts, the English is inline in wording()`)
      }
    }

    expect(found).toEqual([])
  })
})
