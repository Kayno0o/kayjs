import { describe, expect, it } from 'bun:test'
import { brokenLinks } from '../scripts/links'
import { ARCHIVES, INDEX, releasePages, trimArchive } from '../scripts/whats-new'
import { renderMarkdown } from '../src/content/markdown'

const read = async (path: string) => Bun.file(path).text()

describe('the release\'s link check', () => {
  it('names the file and anchor of a link the moved or trimmed pages leave dangling', async () => {
    const islands = (await read('llms/islands.md')).replace('# ', '[Gone](upgrading.md#a-section-the-release-dropped)\n\n# ')
    const upgrading = await read('llms/upgrading.md')

    expect(await brokenLinks()).toEqual([])
    expect(await brokenLinks(new Map([['llms/islands.md', islands]]))).toEqual(['llms/islands.md: /llms/upgrading#a-section-the-release-dropped'])
    expect(await brokenLinks(new Map([['llms/islands.md', islands], ['llms/upgrading.md', `${upgrading}\n## A section the release dropped\n`]]))).toEqual([])
  })

  it('checks a link by path into a library or another doc, whose target must exist', async () => {
    const islands = await read('llms/islands.md')
    const broken = async (target: string) => brokenLinks(new Map([['llms/islands.md', islands.replace('# ', `[Library](${target})\n\n# `)]]))

    expect(await broken('../packages/ui/llms/forms.md#common-tasks')).toEqual([])
    expect(await broken('../packages/cms/llms.txt')).toEqual([])
    expect(await broken('../packages/ui/llms/forms.md#nope')).toEqual(['llms/islands.md: /llms/kayjs-ui-forms#nope'])
    expect(await broken('../packages/ui/llms/nope.md')).toEqual(['llms/islands.md: /llms/kayjs-ui-nope'])
    expect(await broken('../packages/nope/llms.txt')).toEqual(['llms/islands.md: /llms/kayjs-nope'])
    expect(await broken('../../../llms/nope.md')).toEqual(['llms/islands.md: /llms/nope'])
  })

  it('refuses a link into an archive by anchor, as the archive loses its oldest sections at a release', async () => {
    const archive = await read('llms/upgrading-archive.md')
    const anchor = (await renderMarkdown(archive)).headings.at(-1)!.id
    const islands = (await read('llms/islands.md')).replace('# ', `[Old](upgrading-archive.md#${anchor})\n\n# `)
    const broken = await brokenLinks(new Map([['llms/islands.md', islands]]))

    expect(broken).toHaveLength(1)
    expect(broken[0]).toStartWith(`llms/islands.md: upgrading-archive.md#${anchor}`)
  })

  it('names the anchor of a section a trim drops when another page links it', async () => {
    const archive = '# Old\n\nWhat each release before 1.47 added.\n\n## 1.46.0\n\n### Kept\n\n- c\n\n## 1.45.0\n\n### Dropped\n\n- aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    const trimmed = trimArchive(archive, 150)
    const islands = (await read('llms/islands.md')).replace('# ', '[Old](upgrading-archive.md#dropped)\n\n# ')

    expect(trimmed).not.toContain('Dropped')
    expect(await brokenLinks(new Map([['llms/islands.md', islands], ['llms/upgrading-archive.md', trimmed]]))).toContain('llms/islands.md: /llms/upgrading-archive#dropped')
    expect(await brokenLinks(new Map([['llms/islands.md', islands], ['llms/upgrading-archive.md', archive]]))).not.toContain('llms/islands.md: /llms/upgrading-archive#dropped')
  })

  it('finds no broken link in the pages the next release writes', async () => {
    const paths = [INDEX, ...ARCHIVES.flat()]
    const texts = new Map<string, string>(await Promise.all(paths.map(async path => [path, await read(path)] as const)))

    expect(await brokenLinks(await releasePages(path => texts.get(path)!, '9.9.9'))).toEqual([])
  })

  it('follows a link to an upgrade section the release moves to the archive, in any page that links it', async () => {
    const paths = [INDEX, ...ARCHIVES.flat()]
    const texts = new Map<string, string>(await Promise.all(paths.map(async path => [path, await read(path)] as const)))

    // 1.71.0 moves to the archive as the page is over its limit, so the links at its section must follow it.
    texts.set('llms/upgrading.md', `# Upgrading\n\n## 1.72.0\n\n### Big\n\n${'x'.repeat(21_000)}\n\n## 1.71.0\n\n### Moved thing\n\n- c\n\nReleases before 1.71 are in [Old](upgrading-archive.md).\n`)
    texts.set('llms/upgrading-archive.md', '# Old\n\nWhat each release before 1.71 added.\n\n## 1.70.0\n\n- z\n')
    texts.set('llms/islands.md', `# Islands\n\nSee [Moved](upgrading.md#moved-thing) and [Kept](upgrading.md#big).\n`)
    texts.set('docs/src/content/docs/guides/x.md', 'See [Moved](/guides/upgrading#moved-thing).\n')
    const linking = ['llms/islands.md', 'docs/src/content/docs/guides/x.md']
    const pages = await releasePages(path => texts.get(path)!, '9.9.9', linking)

    expect(pages.get('llms/upgrading.md')).not.toContain('Moved thing')
    expect(pages.get('llms/islands.md')).toBe('# Islands\n\nSee [Moved](upgrading-archive.md) and [Kept](upgrading.md#big).\n')
    expect(pages.get('docs/src/content/docs/guides/x.md')).toBe('See [Moved](/guides/upgrading-archive).\n')
    expect(await brokenLinks(pages)).not.toContain('llms/islands.md: /llms/upgrading#moved-thing')
  })

  it('writes llms.txt with the release each archive now starts before', async () => {
    const paths = [INDEX, ...ARCHIVES.flat()]
    const texts = new Map<string, string>(await Promise.all(paths.map(async path => [path, await read(path)] as const)))

    // A page over its limit with an archive of its own, so a release moves 1.2.0 and 1.1.0 into the archive whatever the real pages hold.
    texts.set('llms/whats-new.md', `# New\n\n## Unreleased\n\n${'- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'.repeat(70)}\n## 1.2.0\n\n- b\n\n## 1.1.0\n\n- c\n\nReleases before 1.1 are in [Old](whats-new-archive.md).\n`)
    texts.set('llms/whats-new-archive.md', '# Old\n\nWhat each release before 1.1 added.\n\n## 1.0.0\n\n- z\n')
    const pages = await releasePages(path => texts.get(path)!, '9.9.9')
    const before = (text: string) => (/before \d+\.\d+(?:\.\d+)?/).exec(text)![0]
    const line = (text: string, archive: string) => text.split('\n').find(line => line.includes(`(${archive})`))!

    expect(before(pages.get('llms/whats-new-archive.md')!)).toBe('before 9.9.9')
    expect(before(line(pages.get(INDEX)!, 'llms/whats-new-archive.md'))).toBe(before(pages.get('llms/whats-new-archive.md')!))
    // The real upgrading page may be over its limit too, so its line follows its archive, moved or not.
    expect(before(line(pages.get(INDEX)!, 'llms/upgrading-archive.md'))).toBe(before(pages.get('llms/upgrading-archive.md') ?? texts.get('llms/upgrading-archive.md')!))
  })
})
