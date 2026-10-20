// The two published models a page's footprint follows, so `kay build` and the dev tool give the same figures.

// EcoIndex (cnumr/EcoIndex_python, `ecoindex` compute 5.10.0, commit 8833bb3): a score from 0 to 100 of the page's DOM elements, requests and transferred kilobytes, each placed on the quantiles of the pages EcoIndex measured.
export const ECOINDEX_VERSION = '5.10.0'

export const GRADES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const
export type Grade = typeof GRADES[number]

const QUANTILES = {
  dom: [0, 47, 75, 159, 233, 298, 358, 417, 476, 537, 603, 674, 753, 843, 949, 1076, 1237, 1459, 1801, 2479, 594_601],
  requests: [0, 2, 15, 25, 34, 42, 49, 56, 63, 70, 78, 86, 95, 105, 117, 130, 147, 170, 205, 281, 3920],
  size: [0, 1.37, 144.7, 319.53, 479.46, 631.97, 783.38, 937.91, 1098.62, 1265.47, 1448.32, 1648.27, 1876.08, 2142.06, 2465.37, 2866.31, 3401.59, 4155.73, 5400.08, 8037.54, 223_212.26],
}
// A grade needs a score above its limit; the last, G, takes the rest.
const GRADE_LIMITS = [80, 70, 55, 40, 25, 10]

// Where a value sits between the quantiles, 0 to 20.
function quantile(quantiles: number[], value: number): number {
  for (let index = 1; index < quantiles.length; index++) {
    if (value < quantiles[index]!)
      return index - 1 + (value - quantiles[index - 1]!) / (quantiles[index]! - quantiles[index - 1]!)
  }

  return quantiles.length - 1
}

// Python's `round`, which EcoIndex scores with, takes a half to the even number.
function roundHalfEven(value: number): number {
  const floor = Math.floor(value)
  const rest = value - floor

  if (rest === 0.5)
    return floor % 2 === 0 ? floor : floor + 1

  return Math.round(value)
}

// `bytes` is the page's transferred size; EcoIndex counts it in kilobytes of 1000.
export function ecoindexScore({ dom, requests, bytes }: { dom: number, requests: number, bytes: number }): number {
  const weighted = 3 * quantile(QUANTILES.dom, dom) + 2 * quantile(QUANTILES.requests, requests) + quantile(QUANTILES.size, bytes / 1000)

  return roundHalfEven(100 - 5 * weighted / 6)
}

export function ecoindexGrade(score: number): Grade {
  const index = GRADE_LIMITS.findIndex(limit => score > limit)

  return GRADES[index === -1 ? GRADES.length - 1 : index]!
}

// Whether `grade` is no better than `limit`.
export function gradeBelow(grade: Grade, limit: Grade): boolean {
  return GRADES.indexOf(grade) > GRADES.indexOf(limit)
}

// The Sustainable Web Design Model, version 4 (sustainablewebdesign.org/estimating-digital-emissions, as the Green Web Foundation's CO2.js 0.19 applies it): kWh per gigabyte moved, for the data centers, the networks and the user devices.
export const SWD_VERSION = 4
const OPERATIONAL_KWH_PER_GB = 0.055 + 0.059 + 0.08
const EMBODIED_KWH_PER_GB = 0.012 + 0.013 + 0.081

// Ember's global average carbon intensity of electricity, in gCO2e per kWh, for the operational and the embodied energy alike.
export const GRID_GCO2E_PER_KWH = 494
// The model's visitor mix, as Website Carbon applies it: three in four views load everything, the rest a cache holds 98% of.
export const FIRST_VISIT_SHARE = 0.75
export const RETURN_VISIT_SHARE = 0.25
export const RETURN_VISIT_RELOAD = 0.02
// Green hosting is not assumed.
const GIGABYTE = 1e9

// The grams of CO2e one view of a page moving `bytes` costs, a visit mix of new and returning visitors averaged.
export function carbonPerView(bytes: number): number {
  const first = bytes / GIGABYTE * (OPERATIONAL_KWH_PER_GB + EMBODIED_KWH_PER_GB) * GRID_GCO2E_PER_KWH

  return first * (FIRST_VISIT_SHARE + RETURN_VISIT_SHARE * RETURN_VISIT_RELOAD)
}

export interface Figures {
  score: number
  grade: Grade
  co2: number
}

export function figuresOf({ dom, requests, bytes }: { dom: number, requests: number, bytes: number }): Figures {
  const score = ecoindexScore({ dom, requests, bytes })

  return { score, grade: ecoindexGrade(score), co2: carbonPerView(bytes) }
}

// The width of the window a page is measured in, at one device pixel per CSS pixel: a laptop's, so a `srcset` is read for a screen most visitors have rather than the largest one.
export const VIEWPORT_WIDTH = 1280
