import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { loadComponents, loadLibraries } from '../docs/src/libraries'
import { loadReference } from '../docs/src/reference'
import { check } from '../src/check'
import { renderMarkdown } from '../src/content/markdown'

const root = join(import.meta.dir, '..')
const llms = await Bun.file(join(root, 'llms.txt')).text()
const docs = (await readdir(join(root, 'llms'))).filter(name => name.endsWith('.md')).sort()
const LISTED = /^- \[[^\]]+\]\(llms\/([\w-]+\.md)\): \S/gm
const LINK = /\]\(((?:llms\/)?[\w-]+\.md)?(#[\w-]+)?\)/g

describe('llms.txt', () => {
  it('stays an index an agent reads whole, listing every doc of llms/ once', () => {
    const listed = [...llms.matchAll(LISTED)].map(match => match[1]!)

    expect(llms.length).toBeLessThan(10_000)
    expect(listed.toSorted()).toEqual(docs)
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('links only to docs and headings that exist', async () => {
    const files = ['llms.txt', ...docs.map(name => `llms/${name}`)]
    const ids = new Map(await Promise.all(files.map(async file => [file, new Set((await renderMarkdown(await Bun.file(join(root, file)).text())).headings.map(heading => heading.id))] as const)))
    const broken: string[] = []

    for (const file of files) {
      for (const [link, path, anchor] of (await Bun.file(join(root, file)).text()).matchAll(LINK)) {
        const target = path === undefined ? file : file === 'llms.txt' ? path : `llms/${path}`

        if (!ids.has(target) || (anchor !== undefined && !ids.get(target)!.has(anchor.slice(1))))
          broken.push(`${file}: ${link}`)
      }
    }

    expect(broken).toEqual([])
  })
})

describe('the documentation site', () => {
  it('gives llms.txt and each doc it lists a page, links between them made links between pages', async () => {
    const pages = await loadReference()

    expect(pages.map(page => page.slug)).toEqual(['overview', ...[...llms.matchAll(LISTED)].map(match => match[1]!.replace('.md', ''))])
    expect(pages.find(page => page.slug === 'server')!.data.title).toBe('Locals, sessions and guards')
    expect(pages.flatMap(page => [...page.body.matchAll(LINK)].filter(([, path]) => path !== undefined))).toEqual([])
    expect(pages.find(page => page.slug === 'project')!.body).toContain('](/reference/server#locals)')
  })

  it('gives each library a page, and each kayjs-ui component one with its docs, its example and the props it declares', async () => {
    const components = await loadComponents()
    const button = components.find(component => component.slug === 'button')!
    const props = new Map(button.data.props.map(prop => [prop.name, prop]))

    expect((await loadLibraries()).map(library => library.slug)).toEqual(['kayjs-auth', 'kayjs-mail', 'kayjs-ui'])
    expect(components.filter(component => component.data.section === undefined).map(component => component.slug)).toEqual([])
    expect(button.data).toMatchObject({ title: 'Button', section: 'Icon, Button, IconButton', anchor: 'icon-button-iconbutton' })
    expect(button.data.example).toContain('Button(label=')
    expect(props.get('href')).toMatchObject({ type: 'string', optional: true })
    expect(props.get('variant')).toMatchObject({ type: '"accent" | "danger" | "default"', default: '\'default\'' })
    expect(props.has('disabled')).toBe(false)
    expect(components.find(component => component.slug === 'table')!.data.props.find(prop => prop.name === 'onSort')!.type).toBe('(sort: SortState) => void')
  })

  it('passes kay check, and so does the tutorial\'s example app', async () => {
    expect(await check(join(root, 'docs'))).toEqual([])
    expect(await check(join(root, 'examples/reading-list'))).toEqual([])
  }, 60_000)
})
