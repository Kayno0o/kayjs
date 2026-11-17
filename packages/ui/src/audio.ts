import type { NewTab } from './outside'

// A chapter of the audio.
export interface AudioChapter {
  // What the chapter is called.
  label: string
  // Seconds into the audio. Chapters are in time order, as the player never sorts them.
  start: number
  // A page about the chapter, opened beside it.
  href?: string | undefined
  // Opens the page in a new tab (`true`), the same one (`false`), or a new one when the address leaves the site (`'auto'`, the default).
  newTab?: NewTab | undefined
  // A line under the label.
  subtitle?: string | undefined
  // The chapter's loudness, each from 0 to 1 and evenly spread over its length, drawn as bars in the timeline when any chapter has some.
  peaks?: readonly number[] | undefined
}

export interface AudioCue {
  // Seconds into the audio; the cue is current from `start` up to `end`.
  start: number
  end: number
  text: string
}

// Past its first seconds the chapter playing restarts on a previous step, before them the one before plays, as a player's back button does.
export const RESTART_CHAPTER_SECONDS = 3

// The chapter playing at `seconds`: the last one started, or -1 before the first.
export function chapterAt(chapters: readonly AudioChapter[], seconds: number): number {
  return chapters.findLastIndex(chapter => chapter.start <= seconds)
}

// Where a previous step goes from `seconds`.
export function previousStart(chapters: readonly AudioChapter[], seconds: number): number {
  const at = chapterAt(chapters, seconds)
  const current = chapters[at]

  if (current && seconds - current.start > RESTART_CHAPTER_SECONDS)
    return current.start

  return chapters[Math.max(at - 1, 0)]?.start ?? 0
}

// The cue current at `seconds`, or -1 between two.
export function cueAt(cues: readonly AudioCue[], seconds: number): number {
  return cues.findIndex(cue => seconds >= cue.start && seconds < cue.end)
}

// The cues each chapter holds, in order: a chapter runs from its own start to the next one's. One group holds them all when there are no chapters, and one before the first chapter's start joins the first.
export function cuesByChapter(chapters: readonly AudioChapter[], cues: readonly AudioCue[]): { chapter: number, first: number, cues: AudioCue[] }[] {
  const groups = chapters.length === 0 ? [{ chapter: -1, first: 0, cues: [] as AudioCue[] }] : chapters.map((_, chapter) => ({ chapter, first: 0, cues: [] as AudioCue[] }))
  let at = 0

  for (const [index, cue] of cues.entries()) {
    while (at + 1 < chapters.length && cue.start >= chapters[at + 1]!.start)
      at++

    const group = groups[at]!

    if (group.cues.length === 0)
      group.first = index

    group.cues.push(cue)
  }

  return groups.filter(group => group.cues.length > 0)
}

export interface WaveSegment {
  // The chapter it draws, or -1 for the time before the first.
  chapter: number
  // Its length in seconds: the width it takes in the timeline.
  seconds: number
  // Each bar's height from 0 to 1 and the second its middle falls on.
  bars: { height: number, time: number }[]
}

// The chapters' peaks laid on the timeline, one segment per chapter in order, none when no chapter has peaks. A chapter runs to the next one's start, the last to `length`, or, while that is unknown, as long as the others do on average.
export function waveform(chapters: readonly AudioChapter[], length: number): WaveSegment[] {
  if (!chapters.some(chapter => chapter.peaks && chapter.peaks.length > 0))
    return []

  const spans = chapters.slice(0, -1).map((chapter, index) => chapters[index + 1]!.start - chapter.start)
  const last = chapters.at(-1)!
  const average = spans.length > 0 ? spans.reduce((sum, seconds) => sum + seconds, 0) / spans.length : 1
  const tail = length > last.start ? length - last.start : average
  const segments = chapters.map((chapter, index) => {
    const seconds = Math.max(spans[index] ?? tail, 0)
    const peaks = chapter.peaks ?? []

    return { chapter: index, seconds, bars: peaks.map((peak, bar) => ({ height: Math.min(Math.max(Number.isFinite(peak) ? peak : 0, 0), 1), time: chapter.start + (bar + 0.5) / peaks.length * seconds })) }
  })

  return chapters[0]!.start > 0 ? [{ chapter: -1, seconds: chapters[0]!.start, bars: [] }, ...segments] : segments
}

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

// `m:ss`, or `h:mm:ss` from an hour; nothing known yet reads `0:00`.
export function clock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(whole / SECONDS_PER_HOUR)
  const minutes = Math.floor(whole % SECONDS_PER_HOUR / SECONDS_PER_MINUTE)
  const rest = String(whole % SECONDS_PER_MINUTE).padStart(2, '0')

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

// The player whose lock screen controls are set, so a player leaving the page lifts only its own.
export const lockScreen: { owner: object | undefined } = { owner: undefined }
