import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { isFrench } from '../src/runtime/french'
import { ISLAND_HEADER } from '../src/runtime/server-islands'
import { pages } from '../src/server'
import { frenchSpaces, typographyFor } from '../src/server/typography'
import { scratchBuild } from './prerendered'
import { fixtureCopy } from './scratch'

const routes = 'tests/fixtures/typography/src/routes'
const messages = 'tests/fixtures/typography/src/messages'
const content = 'tests/fixtures/typography/src/content.config.ts'

const N = '\u00A0'
const THIN = '\u202F'

describe('which pages get the French spaces', () => {
  it('takes a lang starting with fr as a language, not as letters', () => {
    expect(['fr', 'FR', 'fr-CA', 'fr-fr', 'fr_BE'].map(isFrench)).toEqual([true, true, true, true, false])
    expect(['en', 'fro', 'frr', 'fry', 'de-fr', ''].map(isFrench)).toEqual([false, false, false, false, false, false])
  })
})

describe('what a page is run through', () => {
  it('is the pass for a French page and nothing for another language or `typography: false`', () => {
    expect(typographyFor('fr-CA', undefined)).toBeFunction()
    expect(typographyFor('fr', true)).toBeFunction()
    expect(typographyFor('fr', false)).toBeUndefined()
    expect(typographyFor('en', undefined)).toBeUndefined()
  })

  it('gives the pass\'s result whatever it remembers: a markup seen before, more than it holds, and a long one', () => {
    const polish = typographyFor('fr', undefined)!
    const markups = Array.from({ length: 20 }, (_, index) => `<p title="n${index} : x">Texte ${index} : fin !</p>${index % 2 === 0 ? '<code>a : b</code>' : ''}`)
    const long = `<p>${'mot '.repeat(20_000)}: fin</p>`

    for (let round = 0; round < 3; round++) {
      for (const markup of [...markups, long, markups[3]!, markups[3]!, long]) {
        const out = polish(markup)

        expect(out).toBe(frenchSpaces(markup))
        expect(out).not.toBe(markup)
      }
    }

    expect(polish('<p>rien à changer</p>')).toBe('<p>rien à changer</p>')
    expect(polish('<p>rien à changer</p>')).toBe('<p>rien à changer</p>')
  })
})

describe('French spaces in a page\'s markup', () => {
  it('reads a tag with quoted values of both kinds, holding a > or not, to its end', () => {
    const html = '<a title=\'x > y\' alt="p : q" data-z="1 > \'2\'" href=/z class=\'a "b" c\'>a : b</a><img alt=\'d : e\'><b>f : g</b>'

    expect(frenchSpaces(html)).toBe(`<a title='x > y' alt="p${N}: q" data-z="1 > '2'" href=/z class='a "b" c'>a${N}: b</a><img alt='d${N}: e'><b>f${N}: g</b>`)
  })

  it('turns the space before : ; ! ? and inside « » into a non-breaking one', () => {
    expect(frenchSpaces('<p>Bonjour : le monde ! Vraiment ? Oui ; non</p>')).toBe(`<p>Bonjour${N}: le monde${N}! Vraiment${N}? Oui${N}; non</p>`)
    expect(frenchSpaces('<p>« Bonjour »</p>')).toBe(`<p>«${N}Bonjour${N}»</p>`)
    expect(frenchSpaces('<p>Il dit : « Qu\'est-ce que c\'est ? »</p>')).toBe(`<p>Il dit${N}: «${N}Qu'est-ce que c'est${N}?${N}»</p>`)
  })

  it('keeps a non-breaking or narrow space the author typed, and does nothing twice', () => {
    const typed = `<p>Oui${N}: non${THIN}! «${THIN}a${THIN}» b${N}; c</p>`

    expect(frenchSpaces(typed)).toBe(typed)

    const once = frenchSpaces('<p>Total : 3 ! « a »</p>')

    expect(frenchSpaces(once)).toBe(once)
  })

  it('leaves times, URLs, query strings and a colon right after a tag as written', () => {
    const written = '<p>À 12:30, voir https://x.fr/a?b=1&amp;c=2 et <b>Note</b>: fin, http://a.fr:8080/x;y=1 !</p>'

    expect(frenchSpaces(written)).toBe(written.replace(' !', `${N}!`))
  })

  it('works within one text node, so a space after a tag is its own text', () => {
    expect(frenchSpaces('<p><b>Note</b> : fin</p>')).toBe(`<p><b>Note</b>${N}: fin</p>`)
    expect(frenchSpaces('<p>Note <b>:</b> fin</p>')).toBe('<p>Note <b>:</b> fin</p>')
  })

  it('does not read an entity\'s semicolon as punctuation', () => {
    const entities = '<p>Tom &amp; Jerry &lt;3 &#233; &nbsp;fin</p>'

    expect(frenchSpaces(entities)).toBe(entities)
    expect(frenchSpaces('<p>Tom &amp; Jerry : fin</p>')).toBe(`<p>Tom &amp; Jerry${N}: fin</p>`)
  })

  it('leaves code, pre, kbd, samp, script, style and textarea alone, and resumes after each', () => {
    const skipped = [
      '<code>a : b</code>',
      '<pre>a : b\n<code>c ; d</code> e ! f</pre>',
      '<kbd>a : b</kbd>',
      '<samp>a ? b</samp>',
      '<script>const x = a ? b : c; if (!d) { log("e : f") }</script>',
      '<style>a:hover { content: "a : b" }</style>',
      '<textarea>a : b</textarea>',
      '<PRE>a : b</PRE>',
      '<SCRIPT>x ? y : z</SCRIPT>',
    ]

    for (const piece of skipped)
      expect(frenchSpaces(`<p>${piece}</p>`)).toBe(`<p>${piece}</p>`)

    expect(frenchSpaces('<p>x : <code>a : b</code> y : <pre>c : d</pre> z : <textarea>e : f</textarea> w : <script>g ? h</script> v :</p>')).toBe(`<p>x${N}: <code>a : b</code> y${N}: <pre>c : d</pre> z${N}: <textarea>e : f</textarea> w${N}: <script>g ? h</script> v${N}:</p>`)
    expect(frenchSpaces('<pre><pre>a : b</pre> c : d</pre> e : f')).toBe(`<pre><pre>a : b</pre> c : d</pre> e${N}: f`)
    expect(frenchSpaces('<codex>a : b</codex>')).toBe(`<codex>a${N}: b</codex>`)
    expect(frenchSpaces('<script type="application/json">{"a": "b : c"}</script><p>d : e</p>')).toBe(`<script type="application/json">{"a": "b : c"}</script><p>d${N}: e</p>`)
  })

  it('leaves comments, the doctype and the await markers alone', () => {
    expect(frenchSpaces('<!doctype html><!-- a : b --><!--kay-await:x-->a : b<!--/kay-await:x-->')).toBe(`<!doctype html><!-- a : b --><!--kay-await:x-->a${N}: b<!--/kay-await:x-->`)
  })

  it('rewrites alt, title, aria-label and the content of a description, and no other attribute', () => {
    const html = '<img alt="Vue : mer" title=\'Titre ! ici\' src="/a b : c.png" aria-label="Fermer : la fenêtre" data-title="a : b" placeholder="Nom : " value="a : b" class="a : b" href="/x ?y">'

    expect(frenchSpaces(html)).toBe(`<img alt="Vue${N}: mer" title='Titre${N}! ici' src="/a b : c.png" aria-label="Fermer${N}: la fenêtre" data-title="a : b" placeholder="Nom : " value="a : b" class="a : b" href="/x ?y">`)

    const head = '<title>Accueil : kay</title><meta name="description" content="Un site : simple"><meta property="og:description" content="Un site : simple"><meta property="og:title" content="Kay : le site"><meta name="twitter:description" content="Un site : simple"><meta name="keywords" content="a : b"><meta name="viewport" content="width=device-width : x">'

    expect(frenchSpaces(head)).toBe(`<title>Accueil${N}: kay</title><meta name="description" content="Un site${N}: simple"><meta property="og:description" content="Un site${N}: simple"><meta property="og:title" content="Kay${N}: le site"><meta name="twitter:description" content="Un site${N}: simple"><meta name="keywords" content="a : b"><meta name="viewport" content="width=device-width : x">`)
    expect(frenchSpaces('<p content="a : b" title="c : d">x</p>')).toBe(`<p content="a : b" title="c${N}: d">x</p>`)
  })

  it('does not take text quoted inside another attribute for an attribute', () => {
    const html = '<a data-x=" title=\'a : b\' alt=&quot;c : d&quot;" href="/x">y</a>'

    expect(frenchSpaces(html)).toBe(html)
  })

  it('leaves the attributes of a skipped element and of the tags inside one', () => {
    const html = '<pre title="a : b"><img alt="c : d"></pre><code title="e : f">g</code><img alt="h : i">'

    expect(frenchSpaces(html)).toBe(`<pre title="a : b"><img alt="c : d"></pre><code title="e : f">g</code><img alt="h${N}: i">`)
  })

  it('survives hostile markup without throwing or touching what it cannot read', () => {
    // A `>` and a `<` inside a quoted attribute are not the tag's end or a new tag.
    expect(frenchSpaces('<a title="a > b : c">x : y</a>')).toBe(`<a title="a > b${N}: c">x${N}: y</a>`)
    expect(frenchSpaces('<img alt="1 < 2 : ok" src="/x"><p>a : b</p>')).toBe(`<img alt="1 < 2${N}: ok" src="/x"><p>a${N}: b</p>`)
    // A bare `<` is text.
    expect(frenchSpaces('<p>1 < 2 : vrai</p>')).toBe(`<p>1 < 2${N}: vrai</p>`)
    expect(frenchSpaces('<p>a <3 : b << c ; d</p>')).toBe(`<p>a <3${N}: b << c${N}; d</p>`)
    // What follows a tag that never closes is left as it came, what came before is not.
    expect(frenchSpaces('<p>a : b</p><div title="x : y')).toBe(`<p>a${N}: b</p><div title="x : y`)
    expect(frenchSpaces('<p>a : b</p><div class')).toBe(`<p>a${N}: b</p><div class`)
    expect(frenchSpaces('<p>a : b</p><')).toBe(`<p>a${N}: b</p><`)
    expect(frenchSpaces('<p>a : b</p><!-- c : d')).toBe(`<p>a${N}: b</p><!-- c : d`)
    expect(frenchSpaces('<p>a : b</p><script>c : d')).toBe(`<p>a${N}: b</p><script>c : d`)
    expect(frenchSpaces('<p>a : b</p><pre>c : d')).toBe(`<p>a${N}: b</p><pre>c : d`)
    expect(frenchSpaces('<p>a : b</p></')).toBe(`<p>a${N}: b</p></`)
    expect(frenchSpaces('<p>a : b</p><a href=\'x')).toBe(`<p>a${N}: b</p><a href='x`)
    // Stray closing tags and an unclosed tag in the middle do not turn the pass off.
    expect(frenchSpaces('</pre></code>a : b<p>c : d')).toBe(`</pre></code>a${N}: b<p>c${N}: d`)
    expect(frenchSpaces('<p <b>a : b</b>')).toBe(`<p <b>a${N}: b</b>`)
    expect(frenchSpaces('<p>a : b</p><?php x : y ?>')).toBe(`<p>a${N}: b</p><?php x : y ?>`)
    // A space between attributes is not text: moving it would turn a mark into part of a name.
    expect(frenchSpaces('<p ? a : b class="c : d">x : y</p><img alt=a : b>')).toBe(`<p ? a : b class="c : d">x${N}: y</p><img alt=a : b>`)
    expect(frenchSpaces('')).toBe('')
    expect(frenchSpaces('a : b')).toBe(`a${N}: b`)
  })

  it('reads huge or endless markup in linear time', () => {
    const big = 'x'.repeat(3_000_000)
    const started = performance.now()

    for (const html of [`<p a : b title="${big}`, `<p title="${big}">a : b</p>`, `<p>${big} : b</p>`, `<script>${big}`, `${'<pre>'.repeat(50_000)} : x`, `${'< '.repeat(100_000)} : x`, '<b>a : b</b>'.repeat(50_000)])
      expect(frenchSpaces(html).replaceAll(N, ' ')).toBe(html)

    expect(performance.now() - started).toBeLessThan(5000)
  })

  it('changes nothing but spaces into non-breaking ones, once, whatever the markup', () => {
    const pieces = ['<p>', '</p>', '<pre>', '</pre>', '<code>', '</code>', ' : ', ' ? ', '«', '»', '« ', ' »', '<', '>', '"', '\'', '<!--', '-->', '<script>', '</script>', '<style>', '</style>', '<textarea>', '</textarea>', 'a', ' ', '<img alt="', '" title=\'', '=', '&amp;', '<b ', '/', '<meta name="description" content="', '<![CDATA[', '<?', ' !', ' ;', '<PRE>', '</Pre>', '\n', '<a href=x title=y : z>']
    let seed = 7

    for (let round = 0; round < 4000; round++) {
      let html = ''

      for (let count = 1 + round % 24; count > 0; count--) {
        seed = (seed * 1103515245 + 12345) % 2147483648
        html += pieces[seed % pieces.length]
      }

      const out = frenchSpaces(html)

      expect(out.replaceAll(N, ' ')).toBe(html)
      expect(frenchSpaces(out)).toBe(out)
    }
  })

  it('is cheap to leave a page with nothing to change as it is', () => {
    const html = '<p>Rien à changer ici.</p>'.repeat(1000)

    expect(frenchSpaces(html)).toBe(html)
  })
})

async function get(site: { handle: (request: Request) => Promise<Response> }, path: string, headers: Record<string, string> = {}): Promise<{ status: number, html: string }> {
  const response = await site.handle(new Request(`http://localhost${path}`, { headers }))

  return { status: response.status, html: await response.text() }
}

// What the home page writes of its text, by where the text comes from: a template, a prop, a `.ts` constant, a Markdown collection, a streamed block, the head.
const SPACED = [
  `<h1>Bienvenue${N}!</h1>`,
  `<p class="plain">Voulez-vous continuer${N}? Oui${N}: non${N}; peut-être</p>`,
  `<p class="guillemets">Il dit «${N}bonjour${N}» à tous</p>`,
  `<p class="constant">Avant${N}: après${N}! Vraiment${N}?</p>`,
  `<p class="prop">Une prop${N}: ici</p>`,
  `alt="Vue${N}: mer" title="Titre${N}! ici"`,
  `<title>Accueil${N}: kay</title>`,
  `<meta name="description" content="Un site${N}: simple">`,
  `Voulez-vous continuer${N}? Oui${N}: non${N}; «${N}peut-être${N}»${N}!`,
  `Résultat${N}: trois`,
]
// What stays as written: a time, a URL, a colon right after a tag, text typed non-breaking or narrow, code and pre, a keywords meta.
const WRITTEN = [
  '<p class="time">Rendez-vous à 12:30 sur https://example.fr/a?b=1</p>',
  '<p class="after"><b>Note</b>: fin</p>',
  `<p class="typed">Déjà${N}: fin${THIN}! ok</p>`,
  '<p class="entity">Déjà&nbsp;: tapé</p>',
  '<pre class="block">a : b ?</pre>',
  '<code class="inline">a : b</code>',
  '<meta name="keywords" content="a : b">',
  '<code>a : b</code>',
  '<pre><code>x : y ?',
  'https://example.fr/a?b=1',
]

function expectSpaced(html: string): void {
  for (const piece of SPACED)
    expect(html).toContain(piece)

  for (const piece of WRITTEN)
    expect(html).toContain(piece)
}

function expectPlain(html: string): void {
  for (const piece of SPACED)
    expect(html).not.toContain(piece)
}

describe('a French page served', () => {
  beforeAll(async () => {
    await pages({ routes, content, prebuilt: false })
  }, 60_000)

  const site = async (more: Record<string, unknown> = {}) => new Elysia().use(await pages({ routes, content, prebuilt: false, security: false, lang: 'fr', inlineStyles: false, onError: () => undefined, ...more }))

  it('writes a non-breaking space for the template, a prop, a constant, a collection, the head and a streamed block, and leaves the rest', async () => {
    const { status, html } = await get(await site(), '/')

    expect(status).toBe(200)
    expectSpaced(html)
  })

  it('leaves the spaces as typed with `typography: false`', async () => {
    const { html } = await get(await site({ typography: false }), '/')

    expectPlain(html)
    expect(html).toContain('<p class="plain">Voulez-vous continuer ? Oui : non ; peut-être</p>')
    expect(html).toContain(`<p class="typed">Déjà${N}: fin${THIN}! ok</p>`)
  })

  it('does nothing to a page that is not French, and costs it nothing', async () => {
    for (const lang of [undefined, 'en', 'de', 'fro']) {
      const { html } = await get(await site({ lang }), '/')

      expectPlain(html)
    }
  })

  it('answers a French lang with a region, and the error and not-found pages', async () => {
    const regional = await site({ lang: 'fr-CA' })

    expectSpaced((await get(regional, '/')).html)

    const missing = await get(regional, '/nowhere')

    expect(missing.status).toBe(404)
    expect(missing.html).toContain(`<h1>Introuvable${N}: désolé${N}!</h1>`)

    const failed = await get(regional, '/boom')

    expect(failed.status).toBe(500)
    expect(failed.html).toContain(`<h1>Erreur 500${N}: désolé${N}!</h1>`)

    const english = await get(await site({ lang: 'en' }), '/nowhere')

    expect(english.html).toContain('<h1>Introuvable : désolé !</h1>')
  })

  it('sends a streamed block spaced as the shell is, with the shell\'s spaces too', async () => {
    const { html } = await get(await site(), '/')
    const block = (/<template data-kay-await="[^"]+"><p class="settled">([^<]*)<\/p><\/template>/).exec(html)

    expect(block?.[1]).toBe(`Résultat${N}: trois`)
    expect(html).toContain(`<h1>Bienvenue${N}!</h1>`)
  })

  it('works under a mount point and with every trailing slash setting', async () => {
    for (const more of [{ base: '/site' }, { trailingSlash: 'always' as const }, { base: '/site/', trailingSlash: 'always' as const }, { trailingSlash: 'ignore' as const }]) {
      const served = await site(more)

      expectSpaced((await get(served, '/')).html)
      expect((await get(served, '/nowhere/')).html).toContain(`Introuvable${N}: désolé${N}!`)
    }
  })

  it('follows the locale of the page on a site that is English otherwise', async () => {
    const i18n = { locales: ['en', 'fr'], defaultLocale: 'en', messages }
    const served = await site({ lang: undefined, i18n })

    expectPlain((await get(served, '/')).html)
    expectSpaced((await get(served, '/fr')).html)
    expect((await get(served, '/fr/nowhere')).html).toContain(`Introuvable${N}: désolé${N}!`)
    expect((await get(served, '/nowhere')).html).toContain('Introuvable : désolé !')

    const french = await site({ lang: undefined, i18n: { ...i18n, defaultLocale: 'fr' } })

    expectSpaced((await get(french, '/')).html)
    expectPlain((await get(french, '/en')).html)
  })

  it('follows the locale of the page for a server island fetched on an English site', async () => {
    const served = await site({ lang: undefined, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages } })
    const header = { [ISLAND_HEADER]: '1' }

    expect((await get(served, '/fr/island?kay_island=1', header)).html).toContain(`<p class="prop">Île${N}: différée</p>`)
    expect((await get(served, '/island?kay_island=1', header)).html).toContain('<p class="prop">Île : différée</p>')
  })

  it('writes the spaces into a page prerendered at build time, served from its file', async () => {
    const build = await scratchBuild()

    try {
      await build.prerender({ routes, content, lang: 'fr', inlineStyles: false })

      const written = await Bun.file(join(build.pages, 'index.html')).text()

      expectSpaced(written)

      const served = await build.serve({ routes, content, security: false, lang: 'fr' })
      const { html } = await get(served, '/')

      expect(html).toBe(written)
    }
    finally {
      await build.remove()
    }
  })

  it('writes the spaces of a server island, rendered when the page is requested and when the browser fetches it', async () => {
    const build = await scratchBuild()

    try {
      await build.prerender({ routes, content, lang: 'fr', inlineStyles: false })

      const built = await Bun.file(join(build.pages, 'island.html')).text()

      expect(built).toContain(`<h1>Îles${N}!</h1>`)
      expect(built).toContain(`Île${N}: différée`)

      const served = await build.serve({ routes, content, security: false, lang: 'fr' })
      const { html } = await get(served, '/island')

      expect(html).toContain(`<p class="prop">Île${N}: serveur</p>`)

      const fetched = await get(served, '/island?kay_island=1', { [ISLAND_HEADER]: '1' })

      expect(fetched.html).toContain(`<p class="prop">Île${N}: différée</p>`)

      const plain = await build.serve({ routes, content, security: false, lang: 'fr', typography: false })

      expect((await get(plain, '/island?kay_island=1', { [ISLAND_HEADER]: '1' })).html).toContain('<p class="prop">Île : différée</p>')
    }
    finally {
      await build.remove()
    }
  })

  it('writes the spaces of the page a visitor offline gets', async () => {
    const i18n = { locales: ['fr'], defaultLocale: 'fr', messages }
    const offline = async (more: Record<string, unknown> = {}) => {
      const served = await pages({ routes, content, prebuilt: false, security: false, site: 'https://x.example', offline: true, i18n, ...more })
      const script = await (await served.handle(new Request('http://localhost/sw.js'))).text()

      return (JSON.parse((/const KAY = (.*)\n/).exec(script)![1]!) as { offline: string }).offline
    }

    expect(await offline()).toContain(`<h1>Hors ligne${N}!</h1><p>Cette page a besoin d'une connexion${N}: aucune n'est ouverte.</p>`)
    expect(await offline({ typography: false })).toContain('<h1>Hors ligne !</h1><p>Cette page a besoin d\'une connexion : aucune n\'est ouverte.</p>')
  })

  it('writes the spaces of a page prerendered in a locale only', async () => {
    const build = await scratchBuild()

    try {
      await build.prerender({ routes, content, inlineStyles: false, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages } })

      expectPlain(await Bun.file(join(build.pages, 'index.html')).text())
      expectSpaced(await Bun.file(join(build.pages, 'fr.html')).text())
    }
    finally {
      await build.remove()
    }
  })
})

describe('a French site exported', () => {
  const CLI = resolve('src/cli.ts')
  let copy: string
  let out: string

  beforeAll(async () => {
    copy = await fixtureCopy('typography')
    out = await mkdtemp(join(tmpdir(), 'kay-typography-'))
    await Promise.all(['boom', 'island'].map(async route => rm(join(copy, `src/routes/${route}.kay`))))
    await Bun.write(join(copy, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ site: 'https://x.example', lang: 'fr', base: '/repo', trailingSlash: 'always', inlineStyles: false })\n`)

    const child = Bun.spawn([process.execPath, CLI, 'build', copy, '--no-check', '--static', '--outdir', out], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    if (code !== 0)
      throw new Error(errors)
  }, 120_000)

  afterAll(async () => {
    await rm(out, { recursive: true, force: true })
    await rm(copy, { recursive: true, force: true })
  })

  it('has the spaces in every page and in 404.html', async () => {
    expectSpaced(await Bun.file(join(out, 'index.html')).text())
    expect(await Bun.file(join(out, '404.html')).text()).toContain(`<h1>Introuvable${N}: désolé${N}!</h1>`)
  })
})
