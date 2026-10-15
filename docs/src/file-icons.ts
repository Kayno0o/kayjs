import type { IconProps } from 'kay/icons'
import BrandDocker from '~icons/tabler/brand-docker'
import BrandTypescript from '~icons/tabler/brand-typescript'
import File from '~icons/tabler/file'
import FileText from '~icons/tabler/file-text'
import FileTypeCss from '~icons/tabler/file-type-css'
import FileTypeHtml from '~icons/tabler/file-type-html'
import FileTypeJs from '~icons/tabler/file-type-js'
import Folder from '~icons/tabler/folder'
import Json from '~icons/tabler/json'
import Lock from '~icons/tabler/lock'
import Markdown from '~icons/tabler/markdown'
import Photo from '~icons/tabler/photo'
import Settings from '~icons/tabler/settings'

const EXTENSION = /\.(\w+)$/
// Settings files: `kay.config.ts`, `tsconfig.json`, `.gitignore`, `.env`.
const CONFIG = /(?:^|\.)config\.\w+$|^tsconfig|^\./

const BY_NAME: Record<string, IconProps> = { 'Dockerfile': BrandDocker, 'bun.lock': Lock, 'package.json': Json }
const BY_EXTENSION: Record<string, IconProps> = {
  css: FileTypeCss,
  html: FileTypeHtml,
  ico: Photo,
  jpg: Photo,
  js: FileTypeJs,
  json: Json,
  md: Markdown,
  png: Photo,
  svg: Photo,
  ts: BrandTypescript,
  txt: FileText,
  webp: Photo,
  yaml: FileText,
  yml: FileText,
}

// The icon a file's or a folder's name shows, `kay` for a `.kay` file, which shows kay's logo.
export function fileIcon(name: string): IconProps | 'kay' {
  if (name.endsWith('/'))
    return Folder

  if (name.endsWith('.kay'))
    return 'kay'

  const named = BY_NAME[name]

  if (named)
    return named

  return CONFIG.test(name) ? Settings : BY_EXTENSION[EXTENSION.exec(name)?.[1] ?? ''] ?? File
}
