import type { Tone } from './tone'

// What a component that draws an icon in an IconTile (`iconTile` on Stat and Widget) hands it: the tile's tone, its own colour and its size.
export interface IconTileOptions {
  tone?: Tone | undefined
  color?: string | undefined
  size?: 'sm' | 'md' | 'lg' | undefined
}
