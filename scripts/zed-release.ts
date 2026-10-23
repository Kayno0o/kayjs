// The Zed extension is released with kay: its version and the tag of the grammar it builds are those of the release commit.
const VERSION = /^version = "[^"]+"/m
const REV = /^rev = "[^"]+"/m

export const ZED_MANIFEST = 'editors/zed/extension.toml'

export function zedReleasable(manifest: string): boolean {
  return VERSION.test(manifest) && REV.test(manifest)
}

export function zedRelease(manifest: string, version: string): string {
  return manifest.replace(VERSION, () => `version = "${version}"`).replace(REV, () => `rev = "v${version}"`)
}
