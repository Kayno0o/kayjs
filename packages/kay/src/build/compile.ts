// Single-executable standalone compiler (`kay build --compile [outfile]`)
// Embeds routes, plugins, prerendered HTML, and native zero-copy assets via `with { type: "file" }`.

import type { BunPlugin } from 'bun'
import type { BuildManifest } from './index'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CompileExecutableOptions {
  root: string
  outDir: string
  clientDir: string
  manifest: BuildManifest
  assetPrefix: string
  outfile: string
  kaySrcRoot: string
  resolveKaySpecifier: (specifier: string) => string | undefined
}

export async function compileExecutable(opts: CompileExecutableOptions): Promise<void> {
  const { root, outDir, clientDir, manifest, assetPrefix, outfile, kaySrcRoot, resolveKaySpecifier } = opts
  const entryPath = join(outDir, '__compile_entry.ts')
  const imports: string[] = []
  const modEntries: string[] = []
  const seenFiles = new Set<string>()
  let idx = 0

  const addMod = (rel: string) => {
    if (seenFiles.has(rel))
      return
    seenFiles.add(rel)
    const v = `_m${idx++}`
    imports.push(`import * as ${v} from ${JSON.stringify(join(outDir, rel))};`)
    modEntries.push(`${JSON.stringify(rel)}: ${v}`)
  }

  for (const r of manifest.routes) {
    addMod(r.file)
    for (const l of r.layouts) addMod(l)
    for (const m of r.middlewares) addMod(m)
  }
  if (manifest.errorFile) addMod(manifest.errorFile)
  if (manifest.notFoundFile) addMod(manifest.notFoundFile)
  for (const a of manifest.actions) addMod(a.file)

  const configPath = join(root, 'kay.config.ts')
  const hasConfig = existsSync(configPath)
  if (hasConfig)
    imports.push(`import _kayConfig from ${JSON.stringify(configPath)};`)

  // Embed client assets and public files natively via `with { type: "file" }` (0 base64, 0 startup decode!)
  const embeddedAssets: string[] = []
  let assetIdx = 0
  for (const rel of manifest.assets) {
    const v = `_a${assetIdx++}`
    imports.push(`import ${v} from ${JSON.stringify(join(clientDir, rel))} with { type: "file" };`)
    embeddedAssets.push(`${JSON.stringify(rel)}: ${v}`)
  }
  const embeddedPublic: string[] = []
  const embeddedPublicEtags: string[] = []
  let pubIdx = 0
  for (const rel of manifest.publicFiles) {
    const abs = join(outDir, 'public', rel)
    const v = `_p${pubIdx++}`
    const etag = `W/"${Bun.hash(readFileSync(abs)).toString(36)}"`
    imports.push(`import ${v} from ${JSON.stringify(abs)} with { type: "file" };`)
    embeddedPublic.push(`${JSON.stringify(rel)}: ${v}`)
    embeddedPublicEtags.push(`${JSON.stringify(rel)}: ${JSON.stringify(etag)}`)
  }
  const embeddedPrerendered: string[] = []
  for (const r of manifest.routes) {
    if (r.prerendered) {
      for (const [, relHtml] of Object.entries(r.prerendered)) {
        const html = readFileSync(join(outDir, relHtml), 'utf8')
        embeddedPrerendered.push(`${JSON.stringify(relHtml)}: ${JSON.stringify(html)}`)
      }
    }
  }

  const cfgSpread = hasConfig
    ? `, plugins: _kayConfig?.plugins, lang: _kayConfig?.lang, security: _kayConfig?.security, trustedOrigins: _kayConfig?.trustedOrigins`
    : ''

  // Default NODE_ENV to 'production' in compiled binaries (dynamic key avoids Bun.build constant-folding).
  const code = [
    `import { createServerFromEmbedded } from ${JSON.stringify(join(kaySrcRoot, 'server/index.ts'))};`,
    ...imports,
    `const _envKey = 'NODE_ENV'; process.env[_envKey] ??= 'production';`,
    `const manifest = ${JSON.stringify(manifest)};`,
    `const modules = { ${modEntries.join(', ')} };`,
    `const assets = { ${embeddedAssets.join(', ')} };`,
    `const publicAssets = { ${embeddedPublic.join(', ')} };`,
    `const publicEtags = { ${embeddedPublicEtags.join(', ')} };`,
    `const prerendered = { ${embeddedPrerendered.join(', ')} };`,
    `const app = await createServerFromEmbedded({ manifest, modules, assets, publicAssets, publicEtags, prerendered, assetPrefix: ${JSON.stringify(assetPrefix)}${cfgSpread} });`,
    `const port = Number(process.env.PORT ?? 3000);`,
    `const server = app.serve(port);`,
    `console.log(\`kay server listening on http://localhost:\${server.port}\`);`,
  ].join('\n')

  writeFileSync(entryPath, code)
  try {
    const kayResolvePlugin: BunPlugin = {
      name: 'kay-v2-compile-resolve',
      setup(b) {
        b.onResolve({ filter: /^(?:@kayjs\/)?kay(?:\/.*)?$/ }, (args) => {
          const resolved = resolveKaySpecifier(args.path)
          return resolved !== undefined ? { path: resolved } : undefined
        })
      },
    }
    const res = await Bun.build({
      entrypoints: [entryPath],
      compile: { outfile },
      minify: true,
      plugins: [kayResolvePlugin],
    })
    if (!res.success) {
      const msgs = res.logs.map(l => l.message).join('\n')
      throw new Error(`kay build --compile failed:\n${msgs}`)
    }
  }
  finally {
    rmSync(entryPath, { force: true })
  }
}
