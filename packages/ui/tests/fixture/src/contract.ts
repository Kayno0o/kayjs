import type { JSX } from 'kay'
import Accordion from '@kayjs/ui/accordion.kay'
import AppHeader from '@kayjs/ui/app-header.kay'
import AppSwitcher from '@kayjs/ui/app-switcher.kay'
import AudioPlayer from '@kayjs/ui/audio-player.kay'
import AvatarGroup from '@kayjs/ui/avatar-group.kay'
import Avatar from '@kayjs/ui/avatar.kay'
import Badge from '@kayjs/ui/badge.kay'
import BarChart from '@kayjs/ui/bar-chart.kay'
import BarList from '@kayjs/ui/bar-list.kay'
import BareIconButton from '@kayjs/ui/bare-icon-button.kay'
import Breadcrumb from '@kayjs/ui/breadcrumb.kay'
import Button from '@kayjs/ui/button.kay'
import CardRow from '@kayjs/ui/card-row.kay'
import Card from '@kayjs/ui/card.kay'
import Carousel from '@kayjs/ui/carousel.kay'
import Checkbox from '@kayjs/ui/checkbox.kay'
import ChipGroup from '@kayjs/ui/chip-group.kay'
import CollapsibleSection from '@kayjs/ui/collapsible-section.kay'
import ColorInput from '@kayjs/ui/color-input.kay'
import Combobox from '@kayjs/ui/combobox.kay'
import CommandPalette from '@kayjs/ui/command-palette.kay'
import ConfirmDelete from '@kayjs/ui/confirm-delete.kay'
import ConfirmHost from '@kayjs/ui/confirm-host.kay'
import ContactForm from '@kayjs/ui/contact-form.kay'
import ContributionGraph from '@kayjs/ui/contribution-graph.kay'
import CopyButton from '@kayjs/ui/copy-button.kay'
import DateInput from '@kayjs/ui/date-input.kay'
import DateRangeInput from '@kayjs/ui/date-range-input.kay'
import DateTimeInput from '@kayjs/ui/date-time-input.kay'
import DescriptionList from '@kayjs/ui/description-list.kay'
import Dialog from '@kayjs/ui/dialog.kay'
import EmptyState from '@kayjs/ui/empty-state.kay'
import FileDrop from '@kayjs/ui/file-drop.kay'
import FormDialog from '@kayjs/ui/form-dialog.kay'
import FormField from '@kayjs/ui/form-field.kay'
import Form from '@kayjs/ui/form.kay'
import HoverCard from '@kayjs/ui/hover-card.kay'
import IconButton from '@kayjs/ui/icon-button.kay'
import IconPicker from '@kayjs/ui/icon-picker.kay'
import Icon from '@kayjs/ui/icon.kay'
import ImageCropper from '@kayjs/ui/image-cropper.kay'
import LineChart from '@kayjs/ui/line-chart.kay'
import LoadMore from '@kayjs/ui/load-more.kay'
import MapView from '@kayjs/ui/map-view.kay'
import MarkdownEditor from '@kayjs/ui/markdown-editor.kay'
import Masonry from '@kayjs/ui/masonry.kay'
import MediaGallery from '@kayjs/ui/media-gallery.kay'
import Menu from '@kayjs/ui/menu.kay'
import Meter from '@kayjs/ui/meter.kay'
import MultiSelect from '@kayjs/ui/multi-select.kay'
import NavigationProgress from '@kayjs/ui/navigation-progress.kay'
import Notice from '@kayjs/ui/notice.kay'
import PageHeader from '@kayjs/ui/page-header.kay'
import PageSection from '@kayjs/ui/page-section.kay'
import Pagination from '@kayjs/ui/pagination.kay'
import Popover from '@kayjs/ui/popover.kay'
import Progress from '@kayjs/ui/progress.kay'
import QrCode from '@kayjs/ui/qr-code.kay'
import RadioGroup from '@kayjs/ui/radio-group.kay'
import RangeInput from '@kayjs/ui/range-input.kay'
import Rating from '@kayjs/ui/rating.kay'
import RecordButton from '@kayjs/ui/record-button.kay'
import RowsField from '@kayjs/ui/rows-field.kay'
import SaveForm from '@kayjs/ui/save-form.kay'
import ScatterChart from '@kayjs/ui/scatter-chart.kay'
import Segmented from '@kayjs/ui/segmented.kay'
import Select from '@kayjs/ui/select.kay'
import SideNav from '@kayjs/ui/side-nav.kay'
import SidePanel from '@kayjs/ui/side-panel.kay'
import SiteFavicon from '@kayjs/ui/site-favicon.kay'
import SiteNav from '@kayjs/ui/site-nav.kay'
import Skeleton from '@kayjs/ui/skeleton.kay'
import Slider from '@kayjs/ui/slider.kay'
import Sparkline from '@kayjs/ui/sparkline.kay'
import SplitLayout from '@kayjs/ui/split-layout.kay'
import Stat from '@kayjs/ui/stat.kay'
import StatusStrip from '@kayjs/ui/status-strip.kay'
import Steps from '@kayjs/ui/steps.kay'
import SubscribeForm from '@kayjs/ui/subscribe-form.kay'
import TabNav from '@kayjs/ui/tab-nav.kay'
import Table from '@kayjs/ui/table.kay'
import Tabs from '@kayjs/ui/tabs.kay'
import TextInput from '@kayjs/ui/text-input.kay'
import Textarea from '@kayjs/ui/textarea.kay'
import ThemeToggle from '@kayjs/ui/theme-toggle.kay'
import TimeInput from '@kayjs/ui/time-input.kay'
import Timeline from '@kayjs/ui/timeline.kay'
import Toaster from '@kayjs/ui/toaster.kay'
import Toggle from '@kayjs/ui/toggle.kay'
import Toolbar from '@kayjs/ui/toolbar.kay'
import TooltipHost from '@kayjs/ui/tooltip-host.kay'
import Tooltip from '@kayjs/ui/tooltip.kay'
import TreeView from '@kayjs/ui/tree-view.kay'
import VirtualList from '@kayjs/ui/virtual-list.kay'
import WhenVisible from '@kayjs/ui/when-visible.kay'
import Widget from '@kayjs/ui/widget.kay'
import ZoomPane from '@kayjs/ui/zoom-pane.kay'

const noop = () => undefined
const action = Object.assign(async () => undefined, { pending: () => false, url: '/_kay/action/contract', error: () => undefined, succeeded: () => false })
const icon = 'plus'
const rows = [{ key: 'a', label: 'Mars', value: 2, display: 'two' }, { key: 'b', label: 'Venus', value: 1 }]
const tree = [{ key: 'mars', label: 'Mars', children: [{ key: 'phobos', label: 'Phobos' }] }, { key: 'venus', label: 'Venus' }]
const options = [{ value: 'mars', label: 'Mars' }, { value: 'earth', label: 'Earth' }]
const media = [{ key: 1, kind: 'image', thumb: '/a-thumb.png', preview: '/a.png' }, { key: 2, kind: 'image', thumb: '/b-thumb.png', preview: '/b.png' }]
const days = Array.from({ length: 14 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, value: index % 3, count: index % 3 }))
const columns = [{ key: 'name', header: 'Name', sortValue: true as const }, { key: 'moons', header: 'Moons', numeric: true as const }]
const planets = [{ name: 'Mars', moons: 2 }, { name: 'Earth', moons: 1 }]

// Variants of one component that draw other markup, tested beside the cases: a long table the island windows.
const longRows = Array.from({ length: 200 }, (_, index) => ({ id: index, name: `Row ${index}`, moons: index % 7 }))

export const VARIANTS: Record<string, { of: string, props: Record<string, unknown> }> = {
  'table-virtual': { of: 'table', props: { columns, rows: longRows, rowKey: 'id', virtual: true, filter: ['name'], sort: { key: 'name', direction: 'desc' } } },
}

// The component each file under `src` of the library exports, drawn by `components/contract.kay`.
export const COMPONENTS = {
  'accordion': Accordion,
  'app-header': AppHeader,
  'app-switcher': AppSwitcher,
  'audio-player': AudioPlayer,
  'avatar': Avatar,
  'avatar-group': AvatarGroup,
  'badge': Badge,
  'bar-chart': BarChart,
  'bar-list': BarList,
  'bare-icon-button': BareIconButton,
  'breadcrumb': Breadcrumb,
  'button': Button,
  'card-row': CardRow,
  'card': Card,
  'carousel': Carousel,
  'checkbox': Checkbox,
  'chip-group': ChipGroup,
  'collapsible-section': CollapsibleSection,
  'color-input': ColorInput,
  'combobox': Combobox,
  'command-palette': CommandPalette,
  'confirm-delete': ConfirmDelete,
  'confirm-host': ConfirmHost,
  'contact-form': ContactForm,
  'contribution-graph': ContributionGraph,
  'copy-button': CopyButton,
  'date-input': DateInput,
  'date-range-input': DateRangeInput,
  'date-time-input': DateTimeInput,
  'description-list': DescriptionList,
  'dialog': Dialog,
  'empty-state': EmptyState,
  'file-drop': FileDrop,
  'form': Form,
  'form-dialog': FormDialog,
  'form-field': FormField,
  'hover-card': HoverCard,
  'icon-button': IconButton,
  'icon-picker': IconPicker,
  'icon': Icon,
  'image-cropper': ImageCropper,
  'line-chart': LineChart,
  'load-more': LoadMore,
  'markdown-editor': MarkdownEditor,
  'map-view': MapView,
  'masonry': Masonry,
  'media-gallery': MediaGallery,
  'menu': Menu,
  'meter': Meter,
  'multi-select': MultiSelect,
  'navigation-progress': NavigationProgress,
  'notice': Notice,
  'page-header': PageHeader,
  'page-section': PageSection,
  'pagination': Pagination,
  'popover': Popover,
  'progress': Progress,
  'qr-code': QrCode,
  'radio-group': RadioGroup,
  'range-input': RangeInput,
  'rating': Rating,
  'record-button': RecordButton,
  'rows-field': RowsField,
  'save-form': SaveForm,
  'scatter-chart': ScatterChart,
  'segmented': Segmented,
  'select': Select,
  'side-nav': SideNav,
  'side-panel': SidePanel,
  'site-favicon': SiteFavicon,
  'site-nav': SiteNav,
  'slider': Slider,
  'split-layout': SplitLayout,
  'skeleton': Skeleton,
  'sparkline': Sparkline,
  'status-strip': StatusStrip,
  'stat': Stat,
  'steps': Steps,
  'subscribe-form': SubscribeForm,
  'tab-nav': TabNav,
  'table': Table,
  'tabs': Tabs,
  'text-input': TextInput,
  'textarea': Textarea,
  'theme-toggle': ThemeToggle,
  'time-input': TimeInput,
  'toaster': Toaster,
  'timeline': Timeline,
  'toggle': Toggle,
  'toolbar': Toolbar,
  'tooltip': Tooltip,
  'tooltip-host': TooltipHost,
  'tree-view': TreeView,
  'virtual-list': VirtualList,
  'when-visible': WhenVisible,
  'widget': Widget,
  'zoom-pane': ZoomPane,
} as unknown as Record<string, (props: Record<string, unknown>) => JSX.Element>

// Every component the library exports, with props that draw it.
export const CASES: Record<string, Record<string, unknown>> = {
  'accordion': { items: [{ key: 'mars', label: 'Mars' }, { key: 'venus', label: 'Venus', open: true }], panel: (value: string) => value },
  'app-header': { links: [{ href: '/', label: 'Home', icon }, { href: '/data', label: 'Data' }], current: '/data', label: 'Main', brand: 'Moons', end: 'Ada' },
  'app-switcher': { apps: [{ key: 'atlas', href: '/atlas', label: 'Atlas', icon }, { key: 'hubble', href: '/hubble', label: 'Hubble' }], current: 'hubble' },
  'audio-player': { src: '/episode.mp3', title: 'Episode', chapters: [{ label: 'Intro', start: 0 }, { label: 'News', start: 30 }], cues: [{ start: 0, end: 10, text: 'Hello' }] },
  'avatar': { name: 'Grace', label: 'Grace', status: 'online' },
  'avatar-group': { avatars: [{ name: 'Ada' }, { name: 'Grace' }, { name: 'Linus' }], max: 2, label: 'Team' },
  'badge': { label: 'Draft', icon },
  'bar-chart': { labels: ['a', 'b'], series: [{ name: 'Runs', values: [1, 2] }], label: 'Runs' },
  'bar-list': { rows, onSelect: noop },
  'bare-icon-button': { label: 'Add' },
  'breadcrumb': { label: 'Trail', items: [{ label: 'Home', href: '/' }, { label: 'Moons' }] },
  'button': { label: 'Save', icon },
  'card-row': { left: 'L', right: 'R', actions: 'A', children: 'Mars' },
  'card': { title: 'Moons', children: 'Phobos' },
  'carousel': { slides: [{ src: '/a.png', alt: 'A' }, { src: '/b.png', alt: 'B' }] },
  'checkbox': { label: 'I agree', hint: 'v2' },
  'chip-group': { label: 'Decks', options, value: ['mars'] },
  'collapsible-section': { title: 'Older', boxed: true, children: 'Deimos' },
  'color-input': { label: 'Light', value: '#ff8800', name: 'light' },
  'combobox': { options: [{ value: 'mars', label: 'Mars' }, { value: 'earth', label: 'Earth' }], label: 'Planet', value: 'mars', name: 'planet' },
  'command-palette': { open: false, entries: [{ label: 'Home', group: 'Go', href: '/' }, { label: 'Do', group: 'Act', onSelect: noop }] },
  'confirm-delete': { message: 'Delete this?', failure: 'Could not delete', onConfirm: noop },
  'confirm-host': {},
  'contact-form': { action, nameLabel: 'Name', emailLabel: 'Email', messageLabel: 'Message', submitLabel: 'Send' },
  'contribution-graph': { days, color: 'green', today: '2026-09-05' },
  'copy-button': { text: 'x', label: 'Copy link' },
  'date-input': { 'aria-label': 'Day', 'value': '2026-10-21' },
  'date-range-input': { label: 'Stay', value: ['2026-10-21', null] },
  'date-time-input': { 'aria-label': 'Moment', 'value': '2026-10-21T07:30:00Z' },
  'description-list': { items: [{ label: 'Status', value: 'Healthy' }] },
  'dialog': { open: false, title: 'Rename', onOpenChange: noop, children: 'Body', size: 'full', bare: true },
  'empty-state': { title: 'No moons', description: 'Add one' },
  'file-drop': { 'aria-label': 'Photos', 'onFiles': noop, 'content': () => 'Drop files' },
  'form': { action, failureLabel: 'Failed' },
  'form-dialog': { open: false, title: 'Rename', action, submitLabel: 'Save', failure: 'Failed', onOpenChange: noop },
  'form-field': { label: 'Name', hint: 'As shown', children: '' },
  'hover-card': {},
  'icon-button': { icon, label: 'Add' },
  'icon-picker': { icons: async () => new Promise<never[]>(() => undefined), searchLabel: 'Search icons' },
  'icon': { icon, label: 'Add' },
  'image-cropper': { src: '/map.png' },
  'line-chart': { labels: ['a', 'b'], series: [{ name: 'Visits', values: [1, 2] }], label: 'Visits' },
  'load-more': { list: { rows: () => [], ended: () => false, status: () => 'ready', error: () => undefined, pending: () => false, retry: noop, more: noop } },
  'markdown-editor': { 'value': '# Hi', 'aria-label': 'Body' },
  'masonry': { items: [1, 2], key: (item: number) => item, tile: (item: number) => String(item) },
  'map-view': { label: 'Route', lines: [[[48.85, 2.35], [48.86, 2.36]]] },
  'media-gallery': { items: media },
  'menu': { items: [{ label: 'Edit', onSelect: noop }], label: 'Actions', icon },
  'meter': { value: 3, max: 10, label: 'Disk' },
  'multi-select': { options, label: 'Planets', value: ['mars'] },
  'navigation-progress': { pending: true },
  'notice': { children: 'Saved' },
  'page-header': { title: 'Moons', description: 'Every moon' },
  'page-section': { title: 'Moons', children: 'Phobos' },
  'pagination': { page: 2, pages: 5, url: '/posts' },
  'popover': { trigger: noop, label: 'Panel' },
  'progress': { value: 40, label: 'Export' },
  'qr-code': { value: 'https://kaynooo.fr', label: 'Site' },
  'radio-group': { label: 'Planet', options, value: 'mars' },
  'range-input': { label: 'Hours', min: 0, max: 24 },
  'rating': { value: 4.5, label: 'Rated 4.5 out of 5' },
  'record-button': { onRecord: noop },
  'rows-field': { label: 'Headers', columns: [{ key: 'name', label: 'Header' }], rows: [{ name: 'A' }] },
  'save-form': { action, failure: 'Failed' },
  'scatter-chart': { points: [{ key: 'a', label: 'Hades', x: 1, y: 2 }], label: 'Games' },
  'segmented': { label: 'Range', options, value: 'mars', orientation: 'vertical' },
  'select': { 'aria-label': 'Planet', options, 'value': 'mars' },
  'side-nav': { links: [{ href: '/', label: 'Home' }], current: '/', label: 'Main' },
  'side-panel': { open: false, title: 'Detail', onOpenChange: noop },
  'site-favicon': { name: 'kaynooo.fr' },
  'site-nav': { links: [{ href: '/', label: 'Home' }], current: '/', label: 'Main' },
  'slider': { label: 'Delay', value: 40, min: 0, max: 100, formatValue: (value: number) => `${value} ms` },
  'split-layout': { list: 'L', detail: 'D' },
  'skeleton': { lines: 2, label: 'Loading' },
  'sparkline': { values: [1, 3, 2], label: 'Visits' },
  'status-strip': { cells: ['success', 'danger'], label: 'Up' },
  'stat': { value: 12, label: 'moons', layout: 'tile', tone: 'danger' },
  'steps': { steps: [{ key: 'account', label: 'Account' }, { key: 'details', label: 'Details' }, { key: 'review', label: 'Review' }], current: 'details', url: '/signup?step=details', done: ['account'], label: 'Signup' },
  'subscribe-form': { action, label: 'Email', submitLabel: 'Subscribe' },
  'tab-nav': { links: [{ href: '/', label: 'Home' }], current: '/', label: 'Sections' },
  'table': { columns, rows: planets, rowKey: 'name' },
  'tabs': { tabs: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'a', label: 'Tabs', panel: (value: string) => value },
  'text-input': { 'aria-label': 'Name', 'value': '' },
  'textarea': { 'aria-label': 'Bio' },
  'theme-toggle': {},
  'time-input': { 'aria-label': 'Start', 'value': '09:30' },
  'toaster': {},
  'timeline': { entries: [{ key: 'a', time: '08:00', label: 'Home', icon }, { key: 'b', time: '09:00', label: 'Gap', tone: 'neutral' }], label: 'Day', selected: 'a', onSelectedChange: noop },
  'toggle': { label: 'Digest' },
  'toolbar': { label: 'Actions', caption: 'Mars', children: 'Move' },
  'tooltip': { text: 'Published on Monday', children: 'Published' },
  'tooltip-host': {},
  'tree-view': { nodes: tree, label: 'Planets', selected: 'phobos' },
  'virtual-list': { items: [1, 2, 3], item: (row: number) => String(row), label: 'Numbers' },
  'when-visible': { onVisible: noop },
  'widget': { title: 'Visits', children: '42' },
  'zoom-pane': { label: 'Map', children: 'Picture' },
}
