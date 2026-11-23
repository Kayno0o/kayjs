export interface ImageAsset {
  src: string
  width: number
  height: number
  webpSrcset?: string | undefined
  avifSrcset?: string | undefined
}

export interface ImageHelperOptions {
  sizes?: string | undefined
  priority?: boolean | undefined
}

export interface ImgSpreadProps {
  src: string
  srcset?: string | undefined
  sizes?: string | undefined
  width?: number | undefined
  height?: number | undefined
  loading?: 'lazy' | 'eager' | undefined
  decoding?: 'async' | 'sync' | 'auto' | undefined
  fetchpriority?: 'high' | 'low' | 'auto' | undefined
}

/** Returns responsive <img> props for spreading: `<img {...image(hero, { sizes: '50vw' })} alt="..." />`. */
export function image(asset: ImageAsset | string, options: ImageHelperOptions = {}): ImgSpreadProps {
  if (typeof asset === 'string') {
    return {
      src: asset,
      loading: options.priority ? 'eager' : 'lazy',
      decoding: options.priority ? 'sync' : 'async',
      ...(options.priority ? { fetchpriority: 'high' } : {}),
    }
  }

  return {
    src: asset.src,
    ...(asset.webpSrcset ? { srcset: asset.webpSrcset } : {}),
    ...(options.sizes ? { sizes: options.sizes } : {}),
    ...(asset.width > 0 ? { width: asset.width } : {}),
    ...(asset.height > 0 ? { height: asset.height } : {}),
    loading: options.priority ? 'eager' : 'lazy',
    decoding: options.priority ? 'sync' : 'async',
    ...(options.priority ? { fetchpriority: 'high' } : {}),
  }
}
