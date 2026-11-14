import { describe, expect, it } from 'bun:test'

import { compileKay } from '../src/compiler'

function fixed(source: string): { found: number, text: string } {
  const diagnostics = compileKay(source, 'x.kay', { check: true }).diagnostics.filter(one => one.code === 'deprecated-image-options')
  const edits = diagnostics.flatMap(one => one.fixes?.find(fix => fix.safe)?.edits ?? [])

  return { found: diagnostics.length, text: [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source) }
}

const head = '---\nimport { image } from \'kay/image\'\nimport hero from \'./hero.jpg\'\n---\n'

describe('deprecated-image-options', () => {
  it('writes no-placeholder as placeholder={false}', () => {
    expect(fixed(`${head}img(src={hero} no-placeholder alt="")\n`)).toEqual({ found: 1, text: `${head}img(src={hero} placeholder={false} alt="")\n` })
  })

  it('moves the options of a spread image() to attributes', () => {
    expect(fixed(`${head}img({...image(hero)} alt="")\n`).text).toBe(`${head}img(src={hero} alt="")\n`)
    expect(fixed(`${head}img({...image(hero, { aspect: '1/1' })} alt="")\n`).text).toBe(`${head}img(src={hero} aspect="1/1" alt="")\n`)
    expect(fixed(`${head}img({ ...image(hero, { sizes: '(min-width: 60rem) 50vw, 100vw', quality: 90, placeholder: false }) } alt="")\n`).text)
      .toBe(`${head}img(src={hero} sizes="(min-width: 60rem) 50vw, 100vw" quality={90} placeholder={false} alt="")\n`)
  })

  it('reports with no fix a call it cannot rewrite, and leaves image() on other elements alone', () => {
    for (const source of [
      `${head}img({...image(hero, opts)} alt="")\n`,
      `${head}img({...image(hero, { aspect: '1/1' })} src="/x.png" alt="")\n`,
      `${head}img({...image(hero, { other: 1 })} alt="")\n`,
    ]) {
      const result = fixed(source)

      expect(result.found).toBe(1)
      expect(result.text).toBe(source)
    }

    expect(fixed(`${head}div({...image(hero)})\n`).found).toBe(0)
    expect(fixed(`${head}img({...image(post.photo, { width: post.w, height: post.h })} alt="")\n`).found).toBe(0)
    expect(fixed(`${head}img(src={hero} aspect="1/1" alt="")\n`).found).toBe(0)
  })
})
