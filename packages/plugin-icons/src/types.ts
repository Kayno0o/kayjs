export interface IconData {
  viewBox: string
  width: string
  height: string
  body: string
}

export interface IconifyIcon {
  body?: string | undefined
  parent?: string | undefined
  width?: number | undefined
  height?: number | undefined
  left?: number | undefined
  top?: number | undefined
  rotate?: number | undefined
  hFlip?: boolean | undefined
  vFlip?: boolean | undefined
}

// An Iconify JSON set: its root may carry defaults for the size, offset and transforms of every icon.
export interface IconSet extends Omit<IconifyIcon, 'body' | 'parent'> {
  prefix: string
  icons: Record<string, IconifyIcon>
  aliases?: Record<string, IconifyIcon> | undefined
}
