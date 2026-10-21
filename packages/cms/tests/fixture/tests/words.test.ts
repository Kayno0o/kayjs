import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const site = await testSite({ root: ROOT })
const PAYLOAD = /<script type="application\/json" data-kay-i18n>(.*?)<\/script>/

function sent(html: string): string[] {
  const payload = PAYLOAD.exec(html)?.[1]

  return payload === undefined ? [] : Object.keys((JSON.parse(payload) as { messages: object }).messages)
}

test('the screens read `cms.*` messages in the page\'s locale, plural ones included, and the French the package ships where the app words none', async () => {
  const french = await site.visit('/fr/admin')
  const english = await site.visit('/admin')

  expect(french.find('.kcms-admin-home')[0]?.text).toBe('Administration')
  expect(french.find('.kcms-admin-nav a')[0]?.text).toBe('Contenu')
  expect(french.title()).toBe('Contenu - Administration')
  expect(french.text('main')).toContain('2 entrées')
  expect(english.find('.kcms-admin-home')[0]?.text).toBe('Content admin')
  expect(english.text('main')).toContain('2 entries')
  // `cms.admin.uploads` is the app\'s own, `cms.admin.noCollections` the package\'s.
  expect((await site.visit('/fr/admin/uploads')).title()).toBe('Fichiers inutilisés - Administration')
  expect((await site.visit('/fr/admin/collections/posts')).text('main')).toContain('Brouillon')
})

test('a message with parameters and a plural reads the locale\'s form, a key the app\'s catalog lacks reading the French the package ships', async () => {
  const page = await site.visit('/fr/admin/collections/posts')

  expect(page.find('.kui-table th').map(header => header.text)).toEqual(expect.arrayContaining(['Titre', 'Actions']))
  expect(page.find('.kcms-entries button').map(button => button.text)).toContain('Publier')
  expect((await site.visit('/fr/admin/collections/posts?q=zzz')).text('main')).toContain('Aucun résultat')
})

test('the editor server-renders its texts in the locale, a value holding HTML staying text', async () => {
  const page = await site.visit('/fr/admin/page?path=/fr/blog/hello')
  const editor = page.find('aside.kcms-editor')[0]

  expect(editor?.attributes['aria-label']).toBe('Éditeur de contenu')
  expect(page.find('.kcms-editor-title')[0]?.text).toBe('Modifier cette page')
  expect(page.find('.kcms-editor-head button').map(button => button.text)).toContain('Arrêter de modifier')
  expect(page.find('.kcms-entry-loading')[0]?.text).toBe('Chargement…')
  expect(page.html).toContain('aria-label="&lt;b>Masquer&lt;/b> l\'éditeur"')
  expect(page.html).not.toContain('<b>Masquer</b>')
  expect((await site.visit('/fr/admin/page?path=/fr/empty')).find('.kcms-editor-empty')[0]?.text).toBe('Rien sur cette page ne vient d\'une collection.')
  expect((await site.visit('/admin/page?path=/blog/hello')).find('.kcms-editor-title')[0]?.text).toBe('Edit this page')
})

test('the built editor sends the browser the messages it only reads after the page loaded', async () => {
  const built = await testSite({ root: ROOT, browser: true })

  try {
    expect(sent((await built.visit('/fr/admin/page?path=/fr/blog/hello')).html)).toEqual(expect.arrayContaining(['cms.editor.title', 'cms.file.rejected', 'cms.field.removeItem', 'cms.entry.save']))
    expect(sent((await built.visit('/fr/admin/collections/posts')).html)).toEqual(expect.arrayContaining(['cms.table.title']))
    expect(sent((await built.visit('/fr/admin/uploads')).html)).toEqual(expect.arrayContaining(['cms.uploads.deleteMany', 'cms.uploads.empty']))
    expect(sent((await built.visit('/admin/page?path=/blog/hello')).html)).toEqual([])
  }
  finally {
    await built.close()
  }
}, 120_000)

test('the editor reads the locale in the browser: a list item, a button and the size of a refused file', async () => {
  const built = await testSite({ root: ROOT, browser: true })

  try {
    const page = await built.open('/fr/admin/collections/posts/hello')

    await page.waitUntil(() => document.querySelector('[aria-label="Retirer Élément 1"]') !== null)
    expect(await page.evaluate(() => [...document.querySelectorAll('.kcms-entry-editor .kui-btn')].map(button => button.textContent))).toContain('Ajouter')

    const products = await built.open('/fr/admin/collections/products/mug')

    await products.waitUntil(() => document.querySelector('.kcms-file input[type=file]')?.getAttribute('accept') !== null)
    await products.evaluate(() => {
      const data = new DataTransfer()

      data.items.add(new File([new Uint8Array(100 * 1024)], 'huge.png', { type: 'image/png' }))
      document.querySelector('.kcms-file-drop')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    })
    await products.waitUntil(() => document.querySelector('.kui-toaster')?.textContent?.replaceAll(/\s/g, ' ').includes('huge.png pèse 100 ko, au-delà des 64 ko permis par envoi') === true)
    expect(await products.evaluate(() => [...document.querySelectorAll('.kcms-file .kui-btn')].map(button => button.textContent))).toContain('Téléverser')
    expect(products.errors).toEqual([])
    expect(page.errors).toEqual([])
  }
  finally {
    await built.close()
  }
}, 120_000)

test('a swap from a French page to an English one in edit mode shows the editor in English, and back', async () => {
  const built = await testSite({ root: ROOT, browser: true })

  try {
    const page = await built.open('/fr/admin/page?path=/fr/blog/hello')
    const title = () => document.querySelector('.kcms-editor-title')?.textContent
    const follow = (href: string) => {
      const link = document.createElement('a')

      link.id = 'swap'
      link.href = href
      link.textContent = 'swap'
      document.body.prepend(link)
    }

    await page.waitUntil(() => document.querySelector('.kcms-editor-title')?.textContent === 'Modifier cette page')
    await page.evaluate(() => {
      (window as unknown as Record<string, boolean>).sameDocument = true
    })
    await page.evaluate(follow, '/blog/hello')
    await page.click('#swap')
    await page.waitUntil(() => location.pathname === '/blog/hello')
    await page.waitUntil(() => document.querySelector('.kcms-editor-title')?.textContent === 'Edit this page')
    // Another locale loads the page afresh, which is what keeps the first locale's texts out of the editor.
    expect(await page.evaluate(() => 'sameDocument' in window)).toBe(false)
    expect(await page.evaluate(title)).toBe('Edit this page')
    expect(await page.evaluate(() => document.querySelector('.kcms-editor-head button')?.textContent)).toBe('Stop editing')

    await page.evaluate(follow, '/fr/blog/hello')
    await page.click('#swap')
    await page.waitUntil(() => location.pathname === '/fr/blog/hello')
    await page.waitUntil(() => document.querySelector('.kcms-editor-title')?.textContent === 'Modifier cette page')
    expect(await page.evaluate(() => document.querySelector('.kcms-editor-head button')?.textContent)).toBe('Arrêter de modifier')
    expect(page.errors).toEqual([])
  }
  finally {
    await built.close()
  }
}, 120_000)
