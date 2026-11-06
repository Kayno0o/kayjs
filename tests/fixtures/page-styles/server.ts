import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { Elysia } from 'elysia'
import { pages } from '../../../src/server'

// Started by tests/page-styles.test.ts in a copy of this folder, which builds the app and serves it in production.
const app = new Elysia().use(await pages({ dirs: { routes: 'src/routes' }, client: { lateStyles: process.env.LATE_STYLES === 'true' }, prebuilt: false, plugins: [tailwind] })).listen(0)

console.log(`port ${app.server!.port}`)
