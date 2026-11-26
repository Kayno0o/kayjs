// `kay check` for regions(): a data-kay-target written as a string that names no <Region> in the app's src/.

import type { CheckPluginContext } from '@kayjs/kay/config'
import { join, relative } from 'node:path'

const TARGET_RE = /data-kay-target=["']([^"'{}]+)["']/g
const REGION_RE = /<Region\b[^>]*?\bname=(?:["']([^"'{}]+)["']|\{)/g

export async function checkRegionTargets(ctx: CheckPluginContext): Promise<void> {
  const targets: { file: string, name: string }[] = []
  const regions = new Set<string>()
  let computedName = false
  for await (const path of new Bun.Glob('src/**/*.{ts,tsx}').scan({ cwd: ctx.root })) {
    const file = join(ctx.root, path)
    const text = await Bun.file(file).text()
    for (const match of text.matchAll(TARGET_RE))
      targets.push({ file: relative(ctx.root, file), name: match[1]! })
    for (const match of text.matchAll(REGION_RE)) {
      if (match[1] === undefined)
        computedName = true
      else
        regions.add(match[1])
    }
  }
  if (computedName)
    return
  for (const { file, name } of targets) {
    if (!regions.has(name))
      ctx.error(`[regions] ${file}: data-kay-target="${name}" names no <Region name="${name}"> in src/: add the region, or fix the name`)
  }
}
