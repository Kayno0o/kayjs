import { Elysia } from 'elysia'
import { pages } from '../../../src/server'

// Started by tests/search-arrival-browser.test.ts, whose pages are the ones a search hit opens: the site search is on, so a page marks the words its link carries.
const app = new Elysia().use(await pages({ config: { dirs: { routes: 'tests/fixtures/arrival/src/routes' }, client: { search: true } }, prebuilt: false })).listen(0)

console.log(`port ${app.server!.port}`)
