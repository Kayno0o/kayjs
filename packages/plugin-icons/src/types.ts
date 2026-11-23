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

export interface IconSet {
  prefix: string
  icons: Record<string, IconifyIcon>
  aliases?: Record<string, IconifyIcon> | undefined
  width?: number | undefined
  height?: number | undefined
}
