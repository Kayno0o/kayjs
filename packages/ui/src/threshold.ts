import type { Tone } from './tone'

// A bar changes tone as its value grows: the first step whose `upTo` is at least the value gives its `tone`, whatever the order, and a value past all of them keeps the accent.
export interface Threshold {
  upTo: number
  tone: Tone
}

// Written out so Tailwind sees each class.
const FILLS: Record<Tone, string> = { neutral: 'bg-muted', accent: 'bg-accent', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-info' }

export function thresholdTone(thresholds: Threshold[] | undefined, value: number): Tone | undefined {
  return (thresholds && [...thresholds].sort((a, b) => a.upTo - b.upTo))?.find(step => value <= step.upTo)?.tone
}

export function fillOf(tone: Tone | undefined): string {
  return FILLS[tone ?? 'accent']
}
