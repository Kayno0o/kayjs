// A user agent read as a person would name it, for a list of where they are signed in: `Firefox on Windows`.
export interface Device {
  browser: string | null
  os: string | null
  mobile: boolean
}

// Checked in order: Edge, Opera and Samsung's browser all say Chrome too, and Chrome says Safari.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.].*Safari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/\biPad\b/, 'iPadOS'],
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

const MOBILE = /\bMobi|\biPhone\b|\biPad\b|\bAndroid\b/

export function readDevice(userAgent: string): Device {
  return {
    browser: BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null,
    os: SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null,
    mobile: MOBILE.test(userAgent),
  }
}
