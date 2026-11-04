// The files the type-aware rules judge, in the groups `bun run lint` lints one process each (scripts/lint.ts): the TypeScript program of one process grows with every file it judges, and all of them in one outgrow 4 GB.
// The fixtures are apps of their own, outside the tsconfig. The Astro, Next and Nuxt bench apps are type-checked by their own tools in `bench:check`: their programs loaded here too run eslint out of memory.
export const typeAwareSlices: string[][] = [
  ['src/**/*.ts'],
  ['tests/[a-d]*.ts'],
  ['tests/[e-l]*.ts'],
  ['tests/[m-r]*.ts'],
  ['tests/[!a-r]*.ts'],
  ['*.ts', 'scripts/*.ts'],
  ['bench/*.ts', 'bench/{shared,sites}/**/*.ts'],
  ['bench/apps/{kay,solid,svelte}/**/*.ts'],
]

export const filesTypeAware = typeAwareSlices.flat()
