import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'

// Claude Code's WorktreeCreate and WorktreeRemove hooks, and `just worktree <name>`: a worktree starts at the HEAD it is made from and installs its own dependencies, so its `node_modules/kay -> ..` runs its own source rather than the main checkout's.
// `bun .claude/hooks/worktree.ts create [name]` or `remove`, reading the hook's input on stdin when no name is given; only the worktree path goes to stdout, which Claude Code reads.
// Every bench app too, since `just land` checks them all when a root config such as the lockfile changes.
const PACKAGES = ['.', 'bench/apps/astro', 'bench/apps/next', 'bench/apps/nuxt', 'bench/apps/solid', 'bench/apps/svelte']

async function mainCheckout(dir: string): Promise<string> {
  return dirname((await $`git rev-parse --path-format=absolute --git-common-dir`.cwd(dir).quiet().text()).trim())
}

// Git reads every sibling worktree's admin folder while it adds or removes one, so two running at once fail on the other's half-written one (`failed to read .git/worktrees/<name>/commondir`); the git steps take a lock folder in the common git dir, one at a time, while the installs run in parallel.
const LOCK_STALE_MS = 60_000

async function withLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const lock = join(root, '.git', 'kay-worktree.lock')

  for (;;) {
    try {
      mkdirSync(lock)

      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error

      // A lock left by a killed process is taken over; the rename succeeds for one waiter only, so none removes a lock another just took.
      if (Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > LOCK_STALE_MS) {
        try {
          renameSync(lock, `${lock}.stale-${process.pid}`)
          rmSync(`${lock}.stale-${process.pid}`, { recursive: true, force: true })
        }
        catch {}
      }

      await Bun.sleep(50)
    }
  }

  try {
    return await run()
  }
  finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

async function create(from: string, name: string): Promise<string> {
  const root = await mainCheckout(from)
  const path = join(root, '.claude/worktrees', name)

  await withLock(root, () => $`git worktree add -b ${`worktree-${name}`} ${path} HEAD`.cwd(from).quiet())

  for (const dir of PACKAGES)
    await $`bun install --frozen-lockfile`.cwd(join(path, dir)).quiet()

  return path
}

// The branch goes too once merged; `git branch -d` keeps one holding commits nothing else has.
async function remove(path: string) {
  const root = await mainCheckout(path)
  const branch = (await $`git branch --show-current`.cwd(path).quiet().text()).trim()

  await withLock(root, async () => {
    await $`git worktree remove --force ${path}`.cwd(root).quiet()

    if (branch !== '')
      await $`git branch -d ${branch}`.cwd(root).quiet().nothrow()
  })
}

const [command, name] = process.argv.slice(2)
const input = name === undefined ? await Bun.stdin.json() as { cwd: string, name: string, worktree_path: string } : undefined

if (command === 'create')
  console.log(await create(input?.cwd ?? process.cwd(), input?.name ?? name!))
else if (command === 'remove' && input !== undefined)
  await remove(input.worktree_path)
else
  throw new Error('usage: bun .claude/hooks/worktree.ts create [name] | remove (hook input on stdin)')
