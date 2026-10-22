import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const DEV = join(import.meta.dir, '../src/server/dev.ts')
const WAIT_MS = 600

// A server `kay dev` started: it lets go of the channel, as the preload does, then waits for the answer to its ask for the client build, and reports the CPU the wait took.
const SERVER = `import process from 'node:process'
import { kayDevClient } from ${JSON.stringify(DEV)}

process.channel?.unref()
const before = process.cpuUsage()
await kayDevClient(process.cwd(), {})
const spent = process.cpuUsage(before)
console.log(Math.round((spent.user + spent.system) / 1000))
`

describe('a server waiting for the client build of kay dev', () => {
  it('sleeps through the wait, as Bun spins a core while a released channel is all it waits on', async () => {
    const root = await scratchDir('dev-client-wait-')

    await Bun.write(join(root, 'server.ts'), SERVER)

    const asked = Promise.withResolvers<void>()
    const child = Bun.spawn([process.execPath, 'server.ts'], { cwd: root, stdout: 'pipe', stderr: 'inherit', ipc: (message) => {
      if (typeof message === 'object' && message !== null && 'wantsClient' in message)
        asked.resolve()
    } })

    await asked.promise
    await Bun.sleep(WAIT_MS)
    child.send({ client: 'none' })

    const spent = Number((await new Response(child.stdout).text()).trim())

    await child.exited
    expect(spent).toBeLessThan(WAIT_MS / 3)
  }, 30_000)

  // Fails once Bun waits idle on a released channel (oven-sh/bun#46050): `askKayDev` in src/server/dev.ts can then stop holding it.
  it('needs the channel held, as Bun still spins on a released one', async () => {
    const root = await scratchDir('dev-client-spin-')

    await Bun.write(join(root, 'waiter.ts'), `process.channel!.unref()
const before = process.cpuUsage()
await new Promise(resolve => process.once('message', resolve))
const spent = process.cpuUsage(before)
console.log(Math.round((spent.user + spent.system) / 1000))
process.exit(0)
`)

    const child = Bun.spawn([process.execPath, 'waiter.ts'], { cwd: root, stdout: 'pipe', stderr: 'inherit', ipc: () => undefined })

    await Bun.sleep(WAIT_MS)
    child.send('go')

    const spent = Number((await new Response(child.stdout).text()).trim())

    await child.exited
    // A loaded host gives the spinning child only part of a core, so a tenth of the wait still tells a spin from an idle wait, which costs a few ms.
    expect(spent).toBeGreaterThan(WAIT_MS / 10)
  }, 30_000)
})
