import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cpuTicks, ensureFree, isRunning, killAll, parentOf, processesIn, processTree, stopEverything, tracked, treeCpu, treeMemory } from './serve'

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
  it('counts a busy tree\'s CPU time, and that of a process in its folder that left the tree', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kay-bench-cpu-')))
    const busy = 'const end = Date.now() + 400; while (Date.now() < end);'
    const shell = Bun.spawn(['sh', '-c', `${process.execPath} -e "${busy}"; sleep 30`])
    const orphan = Bun.spawn([process.execPath, '-e', `${busy} await Bun.sleep(30000)`], { cwd: dir })

    try {
      await until(() => treeCpu(shell.pid) >= 150)
      expect(treeCpu(shell.pid)).toBeGreaterThanOrEqual(150)

      const tree = treeCpu(shell.pid)

      await until(() => treeCpu(shell.pid, dir) - tree >= 150)
      expect(treeCpu(shell.pid, dir) - tree).toBeGreaterThanOrEqual(150)
    }
    finally {
      await killAll([...processTree(shell.pid), orphan.pid])
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
