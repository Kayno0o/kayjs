import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it, spyOn } from 'bun:test'
import { nativeExe, nativeManifest } from '../src/compiler/native-typescript'
import { MissingPeerError, noteMissingPeer, peerInstalled, resolvePeer } from '../src/peers'
import { fixtureCopy, scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')

// A production build or start never type-checks, so an install without the native compiler's platform package (an unsupported platform, optional dependencies left out) must still build.
it('builds with the typescript packages missing, and only the type-check asks for them', async () => {
  const dir = await scratchDir('native-typescript')
  const preload = join(dir, 'missing.ts')

  await Bun.write(preload, `const resolveSync = Bun.resolveSync\nBun.resolveSync = (specifier: string, parent: string) => {\n  if (specifier.startsWith('typescript7') || specifier.startsWith('@typescript/typescript-'))\n    throw new Error(\`Cannot find module \${specifier}\`)\n\n  return resolveSync(specifier, parent)\n}\n`)

  const root = resolve(await fixtureCopy('islands'))
  const build = Bun.spawn([process.execPath, '--preload', preload, CLI, 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])

  expect(await build.exited, stdout + stderr).toBe(0)

  const tsgo = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, '../src/tsgo.ts'), '--version'], { stdout: 'pipe', stderr: 'pipe' })

  expect(await tsgo.exited).toBe(1)
  expect(await new Response(tsgo.stderr).text()).toContain('typescript7 is not installed')
}, 60_000)

// The preload makes the two peers resolve nowhere, as in an app that did not install them.
async function withoutPeers(): Promise<{ preload: string, root: string }> {
  const dir = await scratchDir('missing-peers')
  const preload = join(dir, 'missing.ts')

  await Bun.write(preload, `const resolveSync = Bun.resolveSync\nBun.resolveSync = (specifier: string, parent: string) => {\n  if (specifier.startsWith('typescript7') || specifier.startsWith('axe-core'))\n    throw new Error(\`Cannot find module \${specifier}\`)\n\n  return resolveSync(specifier, parent)\n}\n`)

  return { preload, root: resolve(await fixtureCopy('islands')) }
}

async function run(args: string[]): Promise<{ stderr: string, stdout: string, code: number }> {
  const child = Bun.spawn([process.execPath, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

const TYPESCRIPT_COMMAND = 'bun add -d typescript7@npm:typescript@^7.0.2'

it('stops `kay check` at once with the command that installs typescript7, in one line and no stack', async () => {
  const { preload, root } = await withoutPeers()
  const { stderr, code } = await run(['--preload', preload, CLI, 'check', root])

  expect(code).toBe(1)
  expect(stderr.trim().split('\n')).toEqual([expect.stringContaining(TYPESCRIPT_COMMAND)])
  expect(stderr).toStartWith('kay check: typescript7 is not installed')
  expect(stderr).not.toContain('    at ')
}, 60_000)

it('stops `kay build` with the install command alone, no cause line under it', async () => {
  const { preload, root } = await withoutPeers()
  const { stderr, code } = await run(['--preload', preload, CLI, 'build', root])

  expect(code).toBe(1)
  expect(stderr.trim().split('\n')).toEqual([expect.stringContaining(TYPESCRIPT_COMMAND)])
}, 60_000)

it('answers a missing typescript7 as one problem under --format json', async () => {
  const { preload, root } = await withoutPeers()
  const { stdout, code } = await run(['--preload', preload, CLI, 'check', root, '--format', 'json'])

  expect(code).toBe(1)
  expect(JSON.parse(stdout)).toMatchObject({ errors: 1, problems: [{ code: 'missing-peer', message: expect.stringContaining(TYPESCRIPT_COMMAND) }] })
}, 60_000)

it('stops `kay a11y` before it opens a page when axe-core is missing, naming the command that installs it', async () => {
  const { preload, root } = await withoutPeers()
  const { stderr, code } = await run(['--preload', preload, CLI, 'a11y', root, '--dry-run'])

  expect(code).toBe(1)
  expect(stderr.trim()).toBe('kay a11y: axe-core is not installed, and kay needs it for the accessibility checks of `kay dev`, `kay a11y` and `page.a11y()`: run `bun add -d axe-core@^4.14.0`')
}, 60_000)

describe('resolvePeer', () => {
  it('resolves what the app installed, and names the install command at the range of kay\'s peer when it did not', async () => {
    const app = await scratchDir('peer-app')

    await Bun.write(join(app, 'node_modules/axe-core/axe.min.js'), '')
    await Bun.write(join(app, 'node_modules/axe-core/package.json'), '{ "name": "axe-core", "version": "4.14.0", "main": "axe.min.js" }')

    expect(resolvePeer('axe-core', 'axe-core/axe.min.js', app)).toBe(join(app, 'node_modules/axe-core/axe.min.js'))
    expect(peerInstalled('axe-core', app)).toBe(true)

    const bare = await mkdtemp(join(tmpdir(), 'peer-bare-'))

    try {
      expect(peerInstalled('typescript7', bare)).toBe(false)
      expect(() => nativeManifest(bare)).toThrow(MissingPeerError)
      expect(() => nativeExe(bare)).toThrow(`run \`${TYPESCRIPT_COMMAND}\``)
      expect(() => resolvePeer('axe-core', 'axe-core/axe.min.js', bare)).toThrow('run `bun add -d axe-core@^4.14.0`')
    }
    finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

it('says once that what rides on a missing peer is off, and passes any other error by', () => {
  const log = spyOn(console, 'warn').mockImplementation(() => undefined)
  const error = spyOn(console, 'error').mockImplementation(() => undefined)

  try {
    const missing = new MissingPeerError('typescript7 is not installed')

    noteMissingPeer(missing, 'the probe test hint')
    noteMissingPeer(missing, 'the probe test hint')
    noteMissingPeer(new Error('other'), 'another feature')
    noteMissingPeer(missing, 'another feature')

    const lines = [...log.mock.calls, ...error.mock.calls].map(call => call.join(' '))

    expect(lines.filter(line => line.includes('the probe test hint is off'))).toHaveLength(1)
    expect(lines.filter(line => line.includes('another feature is off'))).toHaveLength(1)
  }
  finally {
    log.mockRestore()
    error.mockRestore()
  }
})

it('explains missing-peer from the command line', async () => {
  const { stdout, code } = await run([CLI, 'explain', 'missing-peer'])

  expect(code).toBe(0)
  expect(stdout).toContain('bun add -d')
})

// `kay upgrade` runs the new kay's first check with KAY_UPGRADE_FROM set: the check adds the peers before it does anything else. The stub stands in for `bun add`.
it('adds the peers at the start of `kay check` under KAY_UPGRADE_FROM, and stops when the add fails', async () => {
  const { preload } = await withoutPeers()
  const app = await mkdtemp(join(tmpdir(), 'peer-upgrade-'))
  const record = join(app, 'adds.txt')
  const stub = join(app, 'stub.ts')

  try {
    await Bun.write(join(app, 'package.json'), '{ "name": "app" }')
    await Bun.write(stub, `import { appendFileSync } from 'node:fs'\nconst spawn = Bun.spawn\n// @ts-expect-error a stand-in\nBun.spawn = (command: string[], ...rest: unknown[]) => {\n  if (command[1] !== 'add')\n    return (spawn as Function)(command, ...rest)\n\n  appendFileSync(${JSON.stringify(record)}, command.slice(1).join(' ') + '\\n')\n\n  return { exited: Promise.resolve(Number(process.env.STUB_ADD_EXIT)) }\n}\n`)

    const upgrading = async (exit: string) => {
      const proc = Bun.spawn([process.execPath, '--preload', preload, '--preload', stub, CLI, 'check', app], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_UPGRADE_FROM: '1.96', STUB_ADD_EXIT: exit } })
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

      return { stderr, code }
    }

    const added = await upgrading('0')

    expect(await Bun.file(record).text()).toBe('add --dev typescript7@npm:typescript@^7.0.2 axe-core@^4.14.0\n')
    expect(added.stderr).not.toContain('could not add')

    const failed = await upgrading('1')

    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('could not add typescript7 and axe-core to devDependencies')
  }
  finally {
    await rm(app, { recursive: true, force: true })
  }
}, 60_000)

// A server started with --quiet prints nothing of its own.
it('warns at the start of `kay dev` that the type checks are off, unless --quiet', async () => {
  const { preload, root } = await withoutPeers()
  const start = async (flags: string[]) => {
    const proc = Bun.spawn([process.execPath, '--preload', preload, CLI, 'dev', root, '--port', String(20_000 + Math.floor(Math.random() * 10_000)), ...flags], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), 6000)
    const stderr = await new Response(proc.stderr).text()

    clearTimeout(timer)
    proc.kill()

    return stderr
  }

  expect(await start([])).toContain('kay dev: type checks are off, typescript7 is not installed')
  expect(await start(['--quiet'])).not.toContain('type checks are off')
}, 60_000)
