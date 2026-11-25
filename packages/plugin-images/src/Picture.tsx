/** @jsxImportSource @kayjs/kay */
import type { ImageAsset } from './helpers'
import { image } from './helpers'

export interface PictureProps {
  src: ImageAsset
  alt: string
  sizes?: string | undefined
  priority?: boolean | undefined
  class?: string | undefined
  pictureClass?: string | undefined
  [attr: string]: unknown
}

export function Picture({ src, alt, sizes, priority, class: cls, pictureClass, ...rest }: PictureProps) {
  const imgProps = image(src, { sizes, priority })
  return (
    <picture class={pictureClass}>
      {src.avifSrcset && <source type="image/avif" srcset={src.avifSrcset} sizes={sizes} />}
      {src.webpSrcset && <source type="image/webp" srcset={src.webpSrcset} sizes={sizes} />}
      <img {...imgProps} {...rest} class={cls} alt={alt} />
    </picture>
  )
}
