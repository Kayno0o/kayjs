import type { Section } from '../sections'
import { SECTIONS } from '../sections'

export default (value: string) => SECTIONS.find(section => section.slug === value)?.slug as Section | undefined
