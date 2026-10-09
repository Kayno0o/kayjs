import { Elysia } from 'elysia'
import { pages } from 'kay/server'
import { heroPaths, imageFixture } from './image-fixture'

// Serves the image fixture on a loopback port the way an app does, for a load generator, printing the image route and build file URLs of its imported image. `bun bench/image-serve.ts <port> [variant]`
const VARIANTS: Record<string, object> = {
  stock: {},
  nosecurity: { security: false },
  nocompress: { compress: false },
}
const port = Number(Bun.argv[2] ?? 3999)
const fixture = await imageFixture()
const app = new Elysia().use(await pages({ root: fixture.root, prebuilt: false, log: false, compress: true, ...VARIANTS[Bun.argv[3] ?? 'stock'] })).listen({ port, hostname: '127.0.0.1' })
const origin = `http://127.0.0.1:${port}`
const { image, asset } = heroPaths(await (await fetch(`${origin}/`)).text())

await fetch(`${origin}${image}`)
console.log(`${origin}${image}`)
console.log(`${origin}${asset}`)

process.on('SIGTERM', () => void (async () => {
  await app.stop(true)
  await fixture.dispose()
  process.exit(0)
})())
