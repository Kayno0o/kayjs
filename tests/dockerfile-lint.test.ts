import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check'
import { dockerfileProblems } from '../src/check/dockerfile'
import { scratchDir } from './scratch'

async function withFiles<T>(files: Record<string, string>, run: (root: string) => Promise<T> | T): Promise<T> {
  const root = await scratchDir('dockerfile-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return await run(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const DIGEST = `sha256:${'a'.repeat(64)}`

describe('old-bun-image', () => {
  it('reports a root Dockerfile building from a Bun under the one kay needs, at the version', async () => {
    await withFiles({ 'Dockerfile': 'FROM oven/bun:1.4.3 AS build\nRUN bun install\n', 'Dockerfile.prod': 'FROM --platform=linux/amd64 oven/bun:1.3.0-alpine\n', 'app.Dockerfile': 'FROM oven/bun:1.4.4\n' }, (root) => {
      expect(dockerfileProblems(root, undefined, '>=1.4.4').map(d => [d.file.slice(root.length + 1), d.line, d.column, d.code, d.severity, d.message])).toEqual([
        ['Dockerfile', 1, 15, 'old-bun-image', 'error', 'Dockerfile builds from `oven/bun:1.4.3`, under the Bun >=1.4.4 kay needs'],
        ['Dockerfile.prod', 1, 38, 'old-bun-image', 'error', 'Dockerfile.prod builds from `oven/bun:1.3.0`, under the Bun >=1.4.4 kay needs'],
      ])
    })
  })

  it('leaves a tag that is no full version, a newer Bun, another image and a Dockerfile in a folder alone', async () => {
    await withFiles({ 'Dockerfile': 'FROM oven/bun:1 AS a\nFROM oven/bun:latest AS b\nFROM oven/bun:1.5.0 AS c\nFROM node:20 AS d\nFROM oven/bun:canary AS e\n# FROM oven/bun:1.0.0\n', 'docker/Dockerfile': 'FROM oven/bun:1.0.0\n' }, (root) => {
      expect(dockerfileProblems(root, undefined, '>=1.4.4')).toEqual([])
    })
  })

  it('takes the level the config gives, allow dropping it', async () => {
    await withFiles({ Dockerfile: 'FROM oven/bun:1.4.3\n' }, (root) => {
      expect(dockerfileProblems(root, { 'old-bun-image': 'warn' }, '>=1.4.4').map(d => d.severity)).toEqual(['warning'])
      expect(dockerfileProblems(root, { code: 'allow' }, '>=1.4.4')).toEqual([])
      expect(dockerfileProblems(root, { 'old-bun-image': 'allow' }, '>=1.4.4')).toEqual([])
    })
  })

  it('fixes each stage to the oldest Bun kay runs on, keeping the variant and dropping a digest', async () => {
    await withFiles({ Dockerfile: `FROM oven/bun:1.4.3 AS build\nFROM oven/bun:1.4.2-alpine@${DIGEST} AS run\nCOPY --from=build /app /app\n` }, async (root) => {
      const problems = dockerfileProblems(root, undefined, '>=1.4.4')

      expect(await applySafeFixes(root, problems)).toBe(2)
      expect(await Bun.file(join(root, 'Dockerfile')).text()).toBe('FROM oven/bun:1.4.4 AS build\nFROM oven/bun:1.4.4-alpine AS run\nCOPY --from=build /app /app\n')
      expect(dockerfileProblems(root, undefined, '>=1.4.4')).toEqual([])
    })
  })

  it('reports nothing for a range that is no minimum', async () => {
    await withFiles({ Dockerfile: 'FROM oven/bun:1.0.0\n' }, (root) => {
      expect(dockerfileProblems(root, undefined, '^1.4.4')).toEqual([])
    })
  })
})
