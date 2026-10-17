import { formatNumber } from './i18n'

const KB = 1024
const MB = 1024 * 1024

// `1 MB`, `512 KB`, `200 bytes`: how a refusal tells the visitor the most they may send, in the units another locale writes (`1 Mo`, `200 octets` in French).
export function sizeText(bytes: number, locale = 'en'): string {
  if (locale === 'en' || locale.startsWith('en-')) {
    if (bytes >= MB)
      return `${Number((bytes / MB).toFixed(1))} MB`

    return bytes >= KB ? `${Math.round(bytes / KB)} KB` : `${bytes} bytes`
  }

  if (bytes >= MB)
    return formatNumber(locale, bytes / MB, { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 1 })

  if (bytes >= KB)
    return formatNumber(locale, Math.round(bytes / KB), { style: 'unit', unit: 'kilobyte', unitDisplay: 'short' })

  return formatNumber(locale, bytes, { style: 'unit', unit: 'byte', unitDisplay: 'long' })
}
