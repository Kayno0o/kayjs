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

    expect(await broken('../packages/ui/llms/forms.md#components')).toEqual([])
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

    expect(await brokenLinks(releasePages(path => texts.get(path)!, '9.9.9'))).toEqual([])
  })

  it('writes llms.txt with the release each archive now starts before', async () => {
    const paths = [INDEX, ...ARCHIVES.flat()]
    const texts = new Map<string, string>(await Promise.all(paths.map(async path => [path, await read(path)] as const)))
    const whatsNew = texts.get('llms/whats-new.md')!.replace('\n## ', `\n## Unreleased\n\n- ${'a'.repeat(15_000)}\n\n## `)
    const pages = releasePages(path => path === 'llms/whats-new.md' ? whatsNew : texts.get(path)!, '9.9.9')
    const before = (text: string) => (/before \d+\.\d+(?:\.\d+)?/).exec(text)![0]
    const line = (text: string, archive: string) => text.split('\n').find(line => line.includes(`(${archive})`))!

    expect(before(pages.get('llms/whats-new-archive.md')!)).not.toBe(before(texts.get('llms/whats-new-archive.md')!))
    expect(before(line(pages.get(INDEX)!, 'llms/whats-new-archive.md'))).toBe(before(pages.get('llms/whats-new-archive.md')!))
    expect(line(pages.get(INDEX)!, 'llms/upgrading-archive.md')).toBe(line(texts.get(INDEX)!, 'llms/upgrading-archive.md'))
  })
})
