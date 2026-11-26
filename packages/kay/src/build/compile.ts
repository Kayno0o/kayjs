// Single-executable standalone compiler (`kay build --compile [outfile]`)
// Embeds routes, plugins, prerendered HTML, and native zero-copy assets via `with { type: "file" }`.

import type { BunPlugin } from 'bun'
import type { BuildManifest } from './index'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatBunBuildLogs } from './files'
import { SERVER_ENTRY_FILE } from './server-entry'

export interface CompileExecutableOptions {
  root: string
  outDir: string
  clientDir: string
  manifest: BuildManifest
  assetPrefix: string
  outfile: string
  resolveKaySpecifier: (specifier: string) => string | undefined
  bunPlugins?: BunPlugin[] | undefined
}

export async function compileExecutable(opts: CompileExecutableOptions): Promise<void> {
  const { root, outDir, clientDir, manifest, assetPrefix, outfile, resolveKaySpecifier, bunPlugins = [] } = opts
  const entryPath = join(outDir, '__compile_entry.ts')
  const prodEnvPath = join(outDir, '__compile_prod_env.ts')
  // Evaluated first via ESM static import order so `kay.config.ts` and route modules see NODE_ENV=production!
  writeFileSync(prodEnvPath, `const _envKey = 'NODE_ENV';\nprocess.env[_envKey] ??= 'production';\n`)
  const entryJs = join(outDir, 'server', SERVER_ENTRY_FILE)
  const imports: string[] = [`import ${JSON.stringify(prodEnvPath)};`, `import { createApp, kayConfig } from ${JSON.stringify(entryJs)};`]

  // Embed client assets and public files natively via `with { type: "file" }` (0 base64, 0 startup decode!)
  const embeddedAssets: string[] = []
  let assetIdx = 0
  for (const rel of manifest.assets) {
    const abs = join(clientDir, rel)
    const v = `_a${assetIdx++}`
    imports.push(`import ${v} from ${JSON.stringify(abs)} with { type: "file" };`)
    embeddedAssets.push(`${JSON.stringify(rel)}: ${v}`)
    for (const ext of ['.br', '.gz'] as const) {
      const sidecarAbs = `${abs}${ext}`
      if (existsSync(sidecarAbs)) {
        const sv = `_a${assetIdx++}`
        imports.push(`import ${sv} from ${JSON.stringify(sidecarAbs)} with { type: "file" };`)
        embeddedAssets.push(`${JSON.stringify(`${rel}${ext}`)}: ${sv}`)
      }
    }
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
  const embeddedPrerenderedFiles: string[] = []
  let preIdx = 0
  for (const r of manifest.routes) {
    if (r.prerendered) {
      for (const [, relHtml] of Object.entries(r.prerendered)) {
        const abs = join(outDir, relHtml)
        const v = `_r${preIdx++}`
        imports.push(`import ${v} from ${JSON.stringify(abs)} with { type: "file" };`)
        embeddedPrerenderedFiles.push(`${JSON.stringify(relHtml)}: ${v}`)
      }
    }
  }

  const code = [
    ...imports,
    `const manifest = ${JSON.stringify(manifest)};`,
    `const assets = { ${embeddedAssets.join(', ')} };`,
    `const publicAssets = { ${embeddedPublic.join(', ')} };`,
    `const publicEtags = { ${embeddedPublicEtags.join(', ')} };`,
    `const prerenderedFiles = { ${embeddedPrerenderedFiles.join(', ')} };`,
    `const port = Number(process.env.PORT || kayConfig.port || 3000);`,
    `const hostname = process.env.HOST || undefined;`,
    `if (Bun.argv.includes('--health')) { const probeHost = !hostname || hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname; const r = await fetch(\`http://\${probeHost}:\${port}/\`).catch(() => null); process.exit(r && r.status < 500 ? 0 : 1); }`,
    `const app = await createApp({ assetPrefix: ${JSON.stringify(assetPrefix)}, manifest, assets, publicAssets, publicEtags, prerenderedFiles });`,
    `const server = app.serve(port, hostname);`,
    `console.log(\`kay server listening on http://\${hostname ?? 'localhost'}:\${server.port}\`);`,
  ].join('\n')

  writeFileSync(entryPath, code)
  try {
    const kayResolvePlugin: BunPlugin = {
      name: 'kay-v2-compile-resolve',
      setup(b) {
        b.onResolve({ filter: /^@kayjs\/kay(?:\/.*)?$/ }, (args) => {
          const resolved = resolveKaySpecifier(args.path)
          return resolved !== undefined ? { path: resolved } : undefined
        })
      },
    }
    let res: Awaited<ReturnType<typeof Bun.build>>
    try {
      res = await Bun.build({
        entrypoints: [entryPath],
        compile: { outfile },
        minify: true,
        plugins: [kayResolvePlugin, ...bunPlugins],
      })
    }
    catch (err) {
      if (err instanceof AggregateError && err.errors.length > 0)
        throw new Error(`kay build --compile failed:\n${formatBunBuildLogs(err.errors, root)}`)
      throw err
    }
    if (!res.success) {
      const msgs = formatBunBuildLogs(res.logs, root)
      throw new Error(`kay build --compile failed:\n${msgs}`)
    }
  }
  finally {
    rmSync(entryPath, { force: true })
    rmSync(prodEnvPath, { force: true })
  }
}
