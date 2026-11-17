import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { registerLoader } from '../src/server/loader'
import { mountComponent, testSite } from '../src/test'
import { auditHtml } from '../src/test/a11y-dom'
import { matchHtmlFile, normalizeHtml } from '../src/test/html-snapshot'
import { scratchDir } from './scratch'

const site = await testSite({ dirs: { routes: 'tests/fixtures/a11y-visit/src/routes' }, islands: false })

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await site.close()
  await GlobalRegistrator.unregister()
})

describe('a11y of a visited page', () => {
  it('lists the rules the markup breaks, each with its elements', async () => {
    const violations = await (await site.visit('/')).a11y()
    const rules = violations.map(({ id }) => id)

    expect(rules).toContain('image-alt')
    expect(rules).toContain('button-name')
    expect(violations.find(({ id }) => id === 'image-alt')?.nodes[0]).toMatchObject({ target: 'img', html: '<img src="/a.png" loading="lazy" decoding="async">' })
  })

  it('is empty for a page that passes, and narrows to a selector', async () => {
    expect(await (await site.visit('/fine')).a11y()).toEqual([])
    expect(await (await site.visit('/')).a11y('h1')).toEqual([])
    expect((await (await site.visit('/')).a11y('img')).map(({ id }) => id)).toEqual(['image-alt'])
  })

  it('never runs the page\'s scripts', async () => {
    const violations = await auditHtml('<html lang="en"><head><title>t</title></head><body><main><h1>x</h1><script>document.body.append(document.createElement("img"))</script></main></body></html>', undefined)

    expect(violations).toEqual([])
  })

  it('fails for a selector that matches nothing', async () => {
    await expect((await site.visit('/fine')).a11y('table')).rejects.toThrow('nothing matches table to check')
  })
})

describe('a11y of a mounted component', () => {
  it('checks what it rendered and not the rules of a whole page', async () => {
    await registerLoader(process.cwd())

    const { default: Unlabelled } = await import(resolve('tests/fixtures/mount/unlabelled.kay')) as { default: (props: Record<string, never>) => unknown }
    const mounted = await mountComponent(Unlabelled, {})
    const rules = (await mounted.a11y()).map(({ id }) => id)

    expect(rules).toContain('button-name')
    expect(rules).toContain('image-alt')
    expect(rules).not.toContain('page-has-heading-one')
    expect((await mounted.a11y('img')).map(({ id }) => id)).toEqual(['image-alt'])
    mounted.unmount()
  })
})

describe('normalizeHtml', () => {
  it('puts a tag or run of text on each line, indented, and drops comments', () => {
    expect(normalizeHtml('<main><!--[--><p>Thanks,\n   <b>Ada</b>!</p><!--]--><img src="a.png"><input name="q"></main>')).toBe('<main>\n  <p>\n    Thanks,\n    <b>\n      Ada\n    </b>\n    !\n  </p>\n  <img src="a.png">\n  <input name="q">\n</main>\n')
  })

  it('replaces the hash of a built file, a nonce and the stamp of a form', () => {
    const html = '<link rel="stylesheet" href="/_kay/app-4n8x3k2m.css"><script type="module" nonce="Zm9vYmFy" src="/_kay/chunk-A1B2C3D4.js"></script><form><input type="hidden" name="kay_since" value="123.abc"></form>'

    expect(normalizeHtml(html)).toBe('<link rel="stylesheet" href="/_kay/app-HASH.css">\n<script type="module" nonce="NONCE" src="/_kay/chunk-HASH.js"></script>\n<form>\n  <input type="hidden" name="kay_since" value="STAMP">\n</form>\n')
  })

  it('keeps an eight-letter slug of the app and a stamp whatever the attribute order', () => {
    expect(normalizeHtml('<a href="/img/my-products.svg">x</a><input value="9" type="hidden" name="kay_since">')).toBe('<a href="/img/my-products.svg">\n  x\n</a>\n<input value="STAMP" type="hidden" name="kay_since">\n')
  })

  it('replaces an unquoted nonce', () => {
    expect(normalizeHtml('<script nonce=abc123 src="/x.js"></script>')).toBe('<script nonce="NONCE" src="/x.js"></script>\n')
  })

  it('keeps a tag whole when a quoted attribute holds a >', () => {
    expect(normalizeHtml('<div><a title="a > b" href="/x">go</a></div>')).toBe('<div>\n  <a title="a > b" href="/x">\n    go\n  </a>\n</div>\n')
  })

  it('keeps a script and a pre as they are', () => {
    expect(normalizeHtml('<pre>a\n  b</pre><script>let x = 1 < 2</script>')).toBe('<pre>a\n  b</pre>\n<script>let x = 1 < 2</script>\n')
  })

  it('reads the same for two builds of a page', () => {
    expect(normalizeHtml('<script src="/_kay/app-aaaaaaaa.js"></script>')).toBe(normalizeHtml('<script src="/_kay/app-bbbbbbbb.js"></script>'))
  })
})

describe('matchHtml', () => {
  it('writes the baseline once, then holds the page to it', async () => {
    const dir = await scratchDir('match-html-')
    const file = join(dir, 'home.test.ts')
    const baseline = join(dir, '__html__', 'home.test.ts', 'home.html')
    const ci = process.env.CI

    // A run outside CI writes the missing baseline; CI itself refuses to, which the next test holds.
    delete process.env.CI

    try {
      await matchHtmlFile('<p>\n  one\n</p>\n', 'home', file)
    }
    finally {
      if (ci !== undefined)
        process.env.CI = ci
    }

    expect(await Bun.file(baseline).text()).toBe('<p>\n  one\n</p>\n')
    await matchHtmlFile('<p>\n  one\n</p>\n', 'home', file)
    await expect(matchHtmlFile('<p>\n  two\n</p>\n', 'home', file)).rejects.toThrow(/differs from .*home\.html from line 2: expected " {2}one", got " {2}two"/)
    expect(await Bun.file(`${baseline.slice(0, -5)}.actual.html`).text()).toBe('<p>\n  two\n</p>\n')

    await matchHtmlFile('<p>\n  one\n</p>\n', 'home', file)
    expect(existsSync(`${baseline.slice(0, -5)}.actual.html`)).toBe(false)
  })

  it('writes no missing baseline in a CI run', async () => {
    const dir = await scratchDir('match-html-ci-')
    const ci = process.env.CI

    process.env.CI = 'true'

    try {
      await expect(matchHtmlFile('<p>one</p>\n', 'home', join(dir, 'home.test.ts'))).rejects.toThrow('a CI run writes none')
      expect(existsSync(join(dir, '__html__'))).toBe(false)
    }
    finally {
      if (ci === undefined)
        delete process.env.CI
      else
        process.env.CI = ci
    }
  })

  it('refuses a name that leaves the folder', async () => {
    await expect(matchHtmlFile('', '../home', '/x/home.test.ts')).rejects.toThrow('matchHtml takes a name of letters')
  })

  it('snapshots a visited page, beside this test file', async () => {
    const page = await site.visit('/fine')

    await page.matchHtml('fine-page')
    expect(await Bun.file(join(import.meta.dir, '__html__', 'test-a11y-html.test.ts', 'fine-page.html')).text()).toContain('<link rel="icon" href="/favicon.ico?v=HASH" sizes="16x16 32x32 48x48">')
  })
})
