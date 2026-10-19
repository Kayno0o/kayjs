import type { Subprocess } from 'bun'
import type { Variant } from './sites'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cpuTicks, ensureFree, isRunning, killAll, memory, parentOf, processesIn, processTree, serverMemory, startServer, stopEverything, stopServer, tracked, treeCpu, treeMemory, waitReady } from './serve'

// Burns 200 ms of CPU, however busy the machine.
const BURN = 'while (process.cpuUsage().user < 200_000);'

// Once the process printed that it burnt its CPU time.
async function burnt(process: Subprocess<'ignore', 'pipe'>): Promise<void> {
  let output = ''

  for await (const chunk of process.stdout) {
    output += new TextDecoder().decode(chunk)

    if (output.includes('burnt'))
      return
  }
}

function variantIn(dir: string): Variant {
  return { site: { name: 'bakery', repo: '', astro: '', pages: [] }, kind: 'astro', dir, devDir: `${dir}-dev`, ports: { backend: 0, http: 0, https: 0, dev: 0, sidecar: 0 } }
}

// Polls until `done` holds, a second at most.
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !done(); tries++)
    await Bun.sleep(10)
}

describe('parentOf', () => {
  it('reads the parent after the name, whatever spaces and parentheses the name holds', () => {
    expect(parentOf('4242 (bun) S 17 4242 4242 0 -1')).toBe(17)
    expect(parentOf('4242 (a (b) c) S) R 99 4242 4242 0 -1')).toBe(99)
  })
})

describe('cpuTicks', () => {
  it('adds a process\'s user and system time to those of the children it reaped', () => {
    expect(cpuTicks('4242 (a (b) c) S 17 4242 4242 0 -1 4194560 900 30 0 0 120 30 400 50 20 0 9 0')).toBe(600)
    expect(cpuTicks('4242 (a (b) c) S 17 4242 4242 0 -1 4194560 900 30 0 0 120 30 400 50 20 0 9 0', { own: true })).toBe(150)
  })
})

describe('ensureFree', () => {
  it('fails on a port something answers on, and lets a free one through', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('stale') })
    const port = server.port!

    let refused: unknown

    try {
      await ensureFree(port, 'bakery kay')
    }
    catch (error) {
      refused = error
    }
    finally {
      await server.stop(true)
    }

    expect(String(refused)).toContain(`bakery kay: something already answers on port ${port}`)

    expect(await ensureFree(port, 'bakery kay')).toBeUndefined()
  })
})

describe('processTree', () => {
  it('holds a process and the processes it started, theirs included', async () => {
    const shell = Bun.spawn(['sh', '-c', 'sh -c "sleep 30; true" & sleep 30 & wait'])

    try {
      let tree: number[] = []

      for (let tries = 0; tries < 100 && tree.length < 4; tries++) {
        await Bun.sleep(10)
        tree = processTree(shell.pid)
      }

      expect(tree[0]).toBe(shell.pid)
      expect(tree.length).toBe(4)
      expect(treeMemory(shell.pid).processes).toBe(4)
      expect(treeMemory(shell.pid).pss).toBeGreaterThan(0)
    }
    finally {
      for (const pid of processTree(shell.pid).toReversed())
        process.kill(pid, 'SIGKILL')
      await shell.exited
    }
  })
})

describe('processesIn', () => {
  it('finds a process by the folder it runs in, a subfolder included, and no other', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kay-bench-cwd-')))
    const inside = Bun.spawn(['sleep', '30'], { cwd: dir })
    const outside = Bun.spawn(['sleep', '30'], { cwd: tmpdir() })

    try {
      expect(processesIn(dir)).toEqual([inside.pid])
    }
    finally {
      await killAll([inside.pid, outside.pid])
    }
  })
})

describe('treeCpu', () => {
  it('counts a tree\'s CPU time, a child it reaped included, and that of a process in its folder that left the tree', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kay-bench-cpu-')))
    const shell = Bun.spawn(['sh', '-c', `${process.execPath} -e '${BURN}'; echo burnt; sleep 30`], { stdout: 'pipe' })
    const orphan = Bun.spawn([process.execPath, '-e', `${BURN}; console.log("burnt"); await Bun.sleep(30000)`], { cwd: dir, stdout: 'pipe' })

    try {
      await Promise.all([burnt(shell), burnt(orphan)])
      const tree = treeCpu(shell.pid)

      expect(tree).toBeGreaterThanOrEqual(190)
      expect(treeCpu(shell.pid, dir) - tree).toBeGreaterThanOrEqual(190)
    }
    finally {
      await killAll([...processTree(shell.pid), orphan.pid])
    }
  })

  it('counts a process both in the tree and in the folder once', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kay-bench-once-')))
    const shell = Bun.spawn(['sh', '-c', `${process.execPath} -e '${BURN}; console.log("burnt"); await Bun.sleep(30000)'`], { cwd: dir, stdout: 'pipe' })

    try {
      await burnt(shell)

      expect(treeCpu(shell.pid)).toBeGreaterThanOrEqual(190)
      expect(Math.abs(treeCpu(shell.pid, dir) - treeCpu(shell.pid))).toBeLessThan(50)
    }
    finally {
      await killAll(processTree(shell.pid))
    }
  })
})

describe('killAll', () => {
  it('returns once every process it killed is gone, and takes a pid already gone', async () => {
    const shell = Bun.spawn(['sh', '-c', 'sleep 30 & sleep 30 & wait'])

    await until(() => processTree(shell.pid).length === 3)
    const tree = processTree(shell.pid)

    expect(tree.length).toBe(3)
    expect(tree.every(isRunning)).toBe(true)
    await killAll([...tree, ...tree])

    expect(tree.filter(isRunning)).toEqual([])
    await killAll(tree)
  })
})

describe('stopEverything', () => {
  it('stops what the bench started, its children included, and what runs in the folders named', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kay-bench-stop-')))
    const started = tracked(Bun.spawn(['sh', '-c', 'sleep 30 & wait']))
    const stray = Bun.spawn(['sleep', '30'], { cwd: dir })

    await until(() => processTree(started.pid).length === 2)
    const pids = [...processTree(started.pid), stray.pid]

    expect(pids.every(isRunning)).toBe(true)
    await stopEverything([dir])

    expect(pids.filter(isRunning)).toEqual([])
    expect(started.signalCode).toBe('SIGKILL')
  })
})

describe('stopServer', () => {
  it('stops a server, then the sidecar it started, gone for good', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kay-bench-sidecar-')))
    const server = Bun.spawn(['sh', '-c', 'sleep 30 & exec sleep 30'], { cwd: dir })

    await until(() => processTree(server.pid).length === 2)
    const tree = processTree(server.pid)

    expect(tree.length).toBe(2)
    await stopServer(variantIn(dir), server)

    expect(tree.filter(pid => existsSync(`/proc/${pid}`))).toEqual([])
  })

  it('finds the sidecar in its directory when the server exited first and left it out of its tree', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kay-bench-orphan-')))
    const server = Bun.spawn(['sh', '-c', 'sleep 30 >/dev/null & echo $!'], { cwd: dir, stdout: 'pipe' })
    const sidecar = Number((await new Response(server.stdout).text()).trim())

    await server.exited
    expect(isRunning(sidecar)).toBe(true)
    await stopServer(variantIn(dir), server)

    expect(existsSync(`/proc/${sidecar}`)).toBe(false)
  })
})

describe('startServer', () => {
  it('serves a side before kay with its own command, ready once the page its site names answers', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kay-bench-before-')))
    // Taken by the system, then let go, so the server gets a port nothing holds.
    const probe = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = probe.port!

    await probe.stop(true)

    // The home page needs a session, the sign-in does not.
    const serve = [process.execPath, '-e', 'Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: request => new Response(null, { status: new URL(request.url).pathname === "/login" ? 200 : 401 }) })']
    const variant: Variant = { ...variantIn(dir), site: { name: 'club', repo: '', astro: '', pages: [], ready: '/login', before: { label: 'Elysia', build: [], serve, outputs: [] } }, ports: { backend: port, http: 0, https: 0, dev: 0, sidecar: 0 } }
    const server = await startServer(variant)

    try {
      expect(await waitReady(variant, server)).toBeGreaterThan(0)
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401)
    }
    finally {
      await stopServer(variant, server)
    }
  })
})

describe('serverMemory', () => {
  it('counts a server and its sidecar, their shared pages once and their resident peaks summed', async () => {
    const server = Bun.spawn(['sh', '-c', 'sleep 30 & exec sleep 30'])

    try {
      await until(() => processTree(server.pid).length === 2)
      const tree = processTree(server.pid)
      const counted = serverMemory(server.pid)

      expect(tree.length).toBe(2)
      expect(counted.pss).toBeGreaterThan(0)
      expect(counted.pss).toBeLessThan(tree.reduce((sum, pid) => sum + memory(pid).rss, 0))
      expect(counted.peak).toBe(tree.reduce((sum, pid) => sum + memory(pid).peak, 0))
    }
    finally {
      await killAll(processTree(server.pid))
    }
  })
})
