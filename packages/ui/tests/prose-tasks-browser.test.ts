import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { ui } from '../src/extension'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), config: { extensions: [ui()] }, browser: true })

afterAll(async () => site.close())

describe('task list items in kui-prose', () => {
  it.each(['/prose-tasks', '/prose-tasks-space'])('%s hangs a drawn box where the bullet was, in line with the other items', async (path) => {
    await using page = await site.open(path)
    const found = await page.evaluate(() => {
      const box = (id: string) => document.querySelector<HTMLInputElement>(`#${id} input`)!
      const textLeft = (id: string) => {
        const range = document.createRange()

        range.selectNodeContents(document.getElementById(id)!)
        const first = [...document.getElementById(id)!.querySelectorAll('input')].length > 0 ? document.getElementById(id)!.querySelector('label')!.lastChild! : document.getElementById(id)!.firstChild!

        range.selectNodeContents(first)

        return range.getBoundingClientRect().left
      }
      const style = (id: string) => getComputedStyle(box(id))
      const list = document.querySelector('#prose ul')!.getBoundingClientRect()

      return {
        bullet: getComputedStyle(document.getElementById('open')!).listStyleType,
        size: [box('open').getBoundingClientRect().width, box('open').getBoundingClientRect().height],
        hangs: box('open').getBoundingClientRect().left - list.left,
        aligned: Math.abs(textLeft('open') - textLeft('plain')) < 1,
        drawn: style('open').appearance,
        opacity: [style('open').opacity, style('done').opacity],
        accent: getComputedStyle(document.getElementById('accent')!).backgroundColor,
        checked: style('done').backgroundColor,
        unchecked: style('open').backgroundColor,
      }
    })

    expect(found.bullet).toBe('none')
    expect(found.size).toEqual([16, 16])
    expect(found.hangs).toBeCloseTo(0, 0)
    expect(found.aligned).toBe(true)
    expect(found.drawn).toBe('none')
    expect(found.opacity).toEqual(['1', '1'])
    expect(found.checked).toBe(found.accent)
    expect(found.unchecked).not.toBe(found.accent)
  })
})
