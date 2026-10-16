import tailwind from 'bun-plugin-tailwind'
import { Elysia } from 'elysia'
import { pages } from '../../../src/server'

// Started by tests/page-styles.test.ts in a copy of this folder, which builds the app and serves it in production.
const app = new Elysia().use(await pages({ routes: 'src/routes', prebuilt: false, plugins: [tailwind] })).listen(0)

console.log(`port ${app.server!.port}`)
