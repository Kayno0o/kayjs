import type { KayConfig } from '../config'
import { basename } from 'node:path'
import process from 'node:process'

export interface WindowSettings {
  title: string
  width: number
  height: number
}

// The webview library webview-bun ships for the platform kay runs on, resolved from the project, which a desktop build embeds and `kay dev --desktop` opens.
export function webviewLibrary(root: string): string {
  const name = process.platform === 'win32' ? 'libwebview.dll' : process.platform === 'darwin' ? 'libwebview.dylib' : `libwebview-${process.arch}.so`

  try {
    return Bun.resolveSync(`webview-bun/build/${name}`, root)
  }
  catch {
    throw new Error('kay: a desktop app opens its window through the webview library webview-bun ships, and this project does not depend on it: bun add webview-bun')
  }
}

// The dynamic port range, which no service registers.
const FIRST_PORT = 49152
const PORTS = 16384

// The loopback port an app's server takes while it is free, the same for every build of the project, so its origin, and the storage the webview keeps for it, outlive a launch.
export function desktopPort(root: string): number {
  return FIRST_PORT + Bun.hash.crc32(basename(root)) % PORTS
}

// What a desktop app cannot take, refused before anything builds.
export function refuseDesktopConfig(root: string, config: KayConfig): void {
  if (config.base)
    throw new Error('kay: a desktop app is served to its window from the root, so it takes no base')

  webviewLibrary(root)
}

export function windowSettings(root: string, config: KayConfig): WindowSettings {
  const desktop = config.desktop ?? {}

  return { title: desktop.title ?? config.seo?.name ?? basename(root), width: desktop.width ?? 1024, height: desktop.height ?? 768 }
}
