import { Elysia } from 'elysia'
import { pages } from '../../../src/server'

// Started by tests/navigation.test.ts in a process of its own, which builds the islands this one's pages render, with a service worker keeping two of them.
const app = new Elysia().use(await pages({ routes: 'tests/fixtures/navigation/src/routes', prebuilt: false, offline: { pages: ['/', '/second'] } })).listen(0)

console.log(`port ${app.server!.port}`)
