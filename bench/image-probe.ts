import { pages } from 'kay/server'
import { measure } from 'mitata'
import { heroPaths, imageFixture } from './image-fixture'

// What an imported image's variant costs a request on `/_kay/image`, against the same image as a build file on the `/_kay/*` wildcard. `bun bench/image-probe.ts <variant>`
const VARIANTS: Record<string, object> = {
  stock: {},
  nosecurity: { security: false },
  none: { compress: false, security: false },
}
const variant = Bun.argv[2] ?? 'stock'
const fixture = await imageFixture()
const app = await pages({ root: fixture.root, prebuilt: false, log: false, compress: true, ...VARIANTS[variant] })
const headers = { 'accept': 'image/avif,image/webp,*/*', 'accept-encoding': 'br, gzip' }

try {
  for (const [label, path] of Object.entries(heroPaths(await (await app.handle(new Request('http://localhost/'))).text()))) {
    const request = async (): Promise<number> => (await app.handle(new Request(`http://localhost${path}`, { headers }))).status

    if (await request() !== 200)
      throw new Error(`${path} did not answer 200`)

    const stats = await measure(request, { min_cpu_time: 2e9 })

    console.log(variant.padEnd(12), label.padEnd(6), `${(stats.avg / 1000).toFixed(2)} µs`)
  }
}
finally {
  await fixture.dispose()
}
