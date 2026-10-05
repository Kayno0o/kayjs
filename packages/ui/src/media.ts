export interface MediaItem {
  key: string | number
  kind: 'image' | 'video'
  // Strip thumbnail.
  thumb: string
  // The stage's image, or a video's poster frame.
  preview: string
  // What the lightbox opens an image at, `preview` when omitted.
  full?: string
  // A video's source; an `.m3u8` playlist needs the `hls.js` peer in browsers without native HLS.
  src?: string
  title?: string
}

const HLS_PLAYLIST = /\.m3u8(?:$|\?)/

export function isPlayable(item: MediaItem): item is MediaItem & { src: string } {
  return item.kind === 'video' && Boolean(item.src)
}

// Points a video at `src`, through `hls.js` for a playlist the browser cannot play itself, which is every one but Safari.
// The player is imported only once such a video is shown, and loads nothing before the first play, as `preload="none"` does.
// Hands back what stops the player, for the video's cleanup.
export function playSource(video: HTMLVideoElement, src: string): () => void {
  if (!HLS_PLAYLIST.test(src) || video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src

    return () => undefined
  }

  let player: { destroy: () => void } | undefined
  let disposed = false

  void (async () => {
    const { default: Hls } = await import('hls.js')

    if (disposed)
      return

    if (!Hls.isSupported()) {
      video.src = src

      return
    }

    const hls = new Hls({ autoStartLoad: false })

    player = hls
    hls.loadSource(src)
    hls.attachMedia(video)
    video.addEventListener('play', () => hls.startLoad(), { once: true })
  })()

  return () => {
    disposed = true
    player?.destroy()
  }
}
