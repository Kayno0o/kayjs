import { Elysia } from 'elysia'
import { pages } from '../../../src/server'

// Started by tests/offline.test.ts in a process of its own: the navigation fixture with a service worker keeping two of its pages.
const app = new Elysia().use(await pages({ routes: 'tests/fixtures/navigation/src/routes', prebuilt: false, offline: { pages: ['/', '/second'] } })).listen(0)

console.log(`port ${app.server!.port}`)
