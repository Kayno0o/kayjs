import { t } from 'elysia'
import { collection } from 'kay/content'

// Listed by a page's `sitemap` alone, with no `prerender`; outside the content config, so the tests listing its collections do not meet it.
export const partners = collection({ name: 'partners', load: () => [{ slug: 'acme', data: { title: 'Acme' } }] }, { schema: t.Object({ title: t.String() }) })
