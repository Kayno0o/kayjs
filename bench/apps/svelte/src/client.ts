import type { PageProps } from './types'
import { hydrate } from 'svelte'
import App from './App.svelte'

const props = JSON.parse(document.getElementById('page-data')!.textContent) as PageProps

hydrate(App, { target: document.body, props })
