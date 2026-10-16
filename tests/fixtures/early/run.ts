// Runs outside `bun test`, which fails a test on any rejection nothing has taken yet: this is what a server does with one.
import type { JSX } from '../../../src/runtime/jsx'
import { join } from 'node:path'
import { plugin } from 'bun'
import { kay } from '../../../src/build/plugin'
import { earlyRejections } from '../../../src/runtime/await.server'
import { pages } from '../../../src/server'
import { renderToString } from '../../../src/server/string'

await plugin(kay())

type View<P extends object> = (props: P) => JSX.Element

async function load<P extends object>(name: string): Promise<View<P>> {
  return (await import(join(import.meta.dir, name)) as { default: View<P> }).default
}

const result: Record<string, unknown> = {}
const rejected = () => Promise.reject(new Error('down'))

// Each promise rejects before its block renders.
const early = [rejected(), rejected(), rejected()] as const

await Bun.sleep(20)

result.prop = await renderToString(await load<{ rows: Promise<string[]>, count: number }>('prop.kay'), { rows: early[0], count: 3 })
result.property = await renderToString(await load<{ data: { comments: Promise<string[]> } }>('property.kay'), { data: { comments: early[1] } })
result.made = await renderToString(await load('made.kay'), {})

const app = await pages({ routes: 'tests/fixtures/early/routes', prebuilt: true })

result.page = await (await app.handle(new Request('http://localhost/wrapped'))).text()

const logged: unknown[][] = []
const log = console.error

earlyRejections.graceMs = 30
console.error = (...args: unknown[]) => void logged.push(args)

const lost = Promise.reject(new Error('lost'))
const taken = Promise.reject(new Error('taken'))

await Bun.sleep(10)
await Promise.allSettled([taken])
await Bun.sleep(80)
console.error = log

result.logged = logged.map(args => args.map(arg => arg instanceof Error ? arg.message : String(arg)))
result.alive = lost instanceof Promise

console.log(JSON.stringify(result))
