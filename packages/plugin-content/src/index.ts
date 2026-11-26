// @kayjs/content — Zero-dependency Bun-native Markdown collections, nested YAML frontmatter (Bun.YAML),
// Shiki/custom highlight hook, MDX-lite embedded TSX components, localized collections, TOC, and RSS (`0 KB` client JS).

import type { KayPlugin } from '@kayjs/kay/config'
import type { Collection, InternalCollection } from './collection'
import type { ContentFeed, RssFeedConfig } from './rss'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { definePlugin } from '@kayjs/kay/config'
import { currentApp } from './app'
import {
  COLLECTION_DIR_FOR_ROOT_KEY,
  COLLECTION_OWNER_ROOT_KEY,
  COLLECTION_VALIDATE_KEY,
  COLLECTION_VERSION_KEY,
  DEFINE_COLLECTION_RE,
  discoverAppCollections,
  isInsideOrSame,
  registeredCollections,
  walkCollectionDefFiles,
} from './collection'
import { etagMatches, renderRss } from './rss'

export { defineCollection } from './collection'
export type {
  CodeHighlighter,
  Collection,
  CollectionOptions,
  CollectionOptionsWithoutSchema,
  CollectionOptionsWithSchema,
  CollectionRenderConfig,
  ContentEntry,
  ContentHeading,
  MarkdownComponent,
  MarkdownImageResolver,
  MarkdownImageResult,
  RenderedMarkdown,
  RenderMarkdownOptions,
} from './collection'
export { parseFrontmatter } from './frontmatter'
export { renderMarkdown } from './markdown'
export { renderRss } from './rss'
export type { ContentFeed, RssFeedConfig } from './rss'

const STATIC_COLLECTION_DIR_RE = /\bdefineCollection\s*(?:<[^>]*>)?\s*\(\s*\{[\s\S]*?\bdir\s*:\s*(['"`])([^'"`]+)\1/g

function discoverStaticCollectionDirs(root: string): string[] {
  const absRoot = resolve(root)
  const srcDir = resolve(absRoot, 'src')
  const found: string[] = []
  for (const file of walkCollectionDefFiles(srcDir)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    }
    catch {
      continue
    }
    if (!DEFINE_COLLECTION_RE.test(text))
      continue
    STATIC_COLLECTION_DIR_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = STATIC_COLLECTION_DIR_RE.exec(text)) !== null) {
      const dir = resolve(absRoot, m[2]!)
      if (existsSync(dir) && isInsideOrSame(absRoot, dir))
        found.push(dir)
    }
  }
  return found
}

export function content<const TDataList extends readonly unknown[] = readonly unknown[]>(options?: {
  feeds?: { [K in keyof TDataList]: RssFeedConfig<TDataList[K]> } | undefined
  collections?: readonly Collection<unknown>[] | undefined
}): KayPlugin
export function content(options: { feeds?: readonly ContentFeed[] | undefined, collections?: readonly Collection<unknown>[] | undefined } = {}): KayPlugin {
  const feeds = options.feeds ?? []
  const extraCollections = options.collections ?? []

  function dirOf(c: InternalCollection, root?: string): string {
    return c[COLLECTION_DIR_FOR_ROOT_KEY]?.(root) ?? c.dir
  }

  function activeCollections(root?: string): InternalCollection[] {
    const out = new Set<InternalCollection>()
    for (const f of feeds)
      out.add(f.collection as InternalCollection)
    for (const c of extraCollections)
      out.add(c as InternalCollection)
    const absRoot = root !== undefined ? resolve(root) : currentApp.root()
    for (const c of registeredCollections.values()) {
      const owner = c[COLLECTION_OWNER_ROOT_KEY]
      if (owner !== undefined && absRoot !== undefined && owner !== absRoot)
        continue
      const dir = dirOf(c, absRoot)
      if (!existsSync(dir))
        continue
      if (absRoot === undefined || isInsideOrSame(absRoot, dir))
        out.add(c)
    }
    return [...out]
  }

  return definePlugin({
    name: '@kayjs/content',
    after: ['@kayjs/i18n', '@kayjs/images'],
    watchPaths: (root) => {
      const dirs = new Set<string>()
      for (const c of activeCollections(root))
        dirs.add(dirOf(c, root))
      for (const dir of discoverStaticCollectionDirs(root))
        dirs.add(dir)
      return [...dirs]
    },
    async check(ctx) {
      await discoverAppCollections(ctx.root)
      const seen = new Set<string>()
      for (const c of activeCollections(ctx.root)) {
        const validate = c[COLLECTION_VALIDATE_KEY]
        if (validate === undefined)
          continue
        for (const err of validate(ctx.root)) {
          if (seen.has(err))
            continue
          seen.add(err)
          ctx.error(err)
        }
      }
    },
    build(ctx) {
      for (const feed of feeds) {
        const rel = (feed.path ?? '/rss.xml').replace(/^\/+/, '')
        ctx.emitPublic(rel, renderRss({ ...feed, site: feed.site ?? ctx.site } as RssFeedConfig<unknown>))
      }
    },
    server(api) {
      for (const feed of feeds) {
        const path = feed.path ?? '/rss.xml'
        let memo: { xml: string, etag: string, version: number } | undefined
        api.route('GET', path, (ctx) => {
          const versionFn = (feed.collection as unknown as Record<symbol, (() => number) | undefined>)[COLLECTION_VERSION_KEY]
          const version = versionFn ? versionFn() : -1
          if (api.dev || memo === undefined || memo.version !== version) {
            const xml = renderRss({ ...feed, site: feed.site ?? api.site } as RssFeedConfig<unknown>)
            const etag = `"${Bun.hash(xml).toString(36)}"`
            memo = { xml, etag, version }
          }
          if (etagMatches(ctx.request.headers.get('if-none-match'), memo.etag)) {
            return new Response(null, {
              status: 304,
              headers: { etag: memo.etag },
            })
          }
          return new Response(memo.xml, {
            headers: {
              'content-type': 'application/rss+xml; charset=utf-8',
              'etag': memo.etag,
            },
          })
        })
      }
    },
  })
}
