// What one soak read off one checkout: memory in MiB sampled at even steps through the run, each after a forced collection, the processes those samples came from, and the CPU each unit of work cost.
export interface Readings {
  heap: number[]
  anon: number[]
  processes: number
  cpu: number
}

export interface Part {
  name: string
  unit: string
  // The most the heap and the anonymous memory may grow over the run's second half, in MiB.
  limits: { heap: number, anon: number }
  current: Readings
  baseline?: Readings | undefined
}

// How far the CPU per unit may rise over the baseline's before a quiet run fails.
export const CPU_MARGIN = 1.25

// How much a series' floor rose over its second half: the lowest of its last three samples over the lowest of the three around its middle, so warming up before it does not count, and neither does memory the allocator holds a while before returning it.
export function growth(samples: number[]): number {
  const middle = Math.floor((samples.length - 1) / 2)

  return Math.min(...samples.slice(-3)) - Math.min(...samples.slice(middle - 1, middle + 2))
}

// Memory growth fails a run whatever the load; a CPU rise only fails one run on a quiet host, as the shared host's load moves it by more than the margin.
export function verdict(parts: Part[], quiet: boolean): { failures: string[], notes: string[] } {
  const failures: string[] = []
  const notes: string[] = []

  for (const { name, unit, limits, current, baseline } of parts) {
    if (current.processes > 1)
      failures.push(`${name}: its samples came from ${current.processes} processes, so its memory cannot be compared: keep the run within one process's life`)

    for (const kind of ['heap', 'anon'] as const) {
      const grew = growth(current[kind])

      if (grew > limits[kind])
        failures.push(`${name}: ${kind} grew ${grew.toFixed(1)} MiB over the second half, past ${limits[kind]} MiB`)
    }

    if (baseline === undefined) {
      notes.push(`${name}: no baseline, CPU not compared`)

      continue
    }

    const ratio = current.cpu / baseline.cpu

    if (ratio <= CPU_MARGIN)
      continue

    const rise = `${name}: CPU per ${unit} ${current.cpu.toFixed(1)}, ${((ratio - 1) * 100).toFixed(0)}% over the baseline's ${baseline.cpu.toFixed(1)}`

    if (quiet)
      failures.push(rise)
    else
      notes.push(`${rise}, not judged on a busy host`)
  }

  return { failures, notes }
}
