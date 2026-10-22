import type { JSX } from 'kay'
import Accordion from '@kaynooo/kayjs-ui/accordion.kay'
import AppHeader from '@kaynooo/kayjs-ui/app-header.kay'
import Avatar from '@kaynooo/kayjs-ui/avatar.kay'
import Badge from '@kaynooo/kayjs-ui/badge.kay'
import BarList from '@kaynooo/kayjs-ui/bar-list.kay'
import Breadcrumb from '@kaynooo/kayjs-ui/breadcrumb.kay'
import Button from '@kaynooo/kayjs-ui/button.kay'
import CardRow from '@kaynooo/kayjs-ui/card-row.kay'
import Card from '@kaynooo/kayjs-ui/card.kay'
import Carousel from '@kaynooo/kayjs-ui/carousel.kay'
import Checkbox from '@kaynooo/kayjs-ui/checkbox.kay'
import ChipGroup from '@kaynooo/kayjs-ui/chip-group.kay'
import CollapsibleSection from '@kaynooo/kayjs-ui/collapsible-section.kay'
import CommandPalette from '@kaynooo/kayjs-ui/command-palette.kay'
import ConfirmDelete from '@kaynooo/kayjs-ui/confirm-delete.kay'
import ContactForm from '@kaynooo/kayjs-ui/contact-form.kay'
import ContributionGraph from '@kaynooo/kayjs-ui/contribution-graph.kay'
import CopyButton from '@kaynooo/kayjs-ui/copy-button.kay'
import Dialog from '@kaynooo/kayjs-ui/dialog.kay'
import EmptyState from '@kaynooo/kayjs-ui/empty-state.kay'
import FileDrop from '@kaynooo/kayjs-ui/file-drop.kay'
import FormDialog from '@kaynooo/kayjs-ui/form-dialog.kay'
import FormField from '@kaynooo/kayjs-ui/form-field.kay'
import IconButton from '@kaynooo/kayjs-ui/icon-button.kay'
import IconPicker from '@kaynooo/kayjs-ui/icon-picker.kay'
import Icon from '@kaynooo/kayjs-ui/icon.kay'
import ImageCropper from '@kaynooo/kayjs-ui/image-cropper.kay'
import LineChart from '@kaynooo/kayjs-ui/line-chart.kay'
import LoadMore from '@kaynooo/kayjs-ui/load-more.kay'
import MarkdownEditor from '@kaynooo/kayjs-ui/markdown-editor.kay'
import Masonry from '@kaynooo/kayjs-ui/masonry.kay'
import MediaGallery from '@kaynooo/kayjs-ui/media-gallery.kay'
import Menu from '@kaynooo/kayjs-ui/menu.kay'
import Meter from '@kaynooo/kayjs-ui/meter.kay'
import MultiSelect from '@kaynooo/kayjs-ui/multi-select.kay'
import Notice from '@kaynooo/kayjs-ui/notice.kay'
import PageHeader from '@kaynooo/kayjs-ui/page-header.kay'
import PageSection from '@kaynooo/kayjs-ui/page-section.kay'
import Pagination from '@kaynooo/kayjs-ui/pagination.kay'
import Popover from '@kaynooo/kayjs-ui/popover.kay'
import Progress from '@kaynooo/kayjs-ui/progress.kay'
import QrCode from '@kaynooo/kayjs-ui/qr-code.kay'
import RadioGroup from '@kaynooo/kayjs-ui/radio-group.kay'
import RangeInput from '@kaynooo/kayjs-ui/range-input.kay'
import Rating from '@kaynooo/kayjs-ui/rating.kay'
import SaveForm from '@kaynooo/kayjs-ui/save-form.kay'
import ScatterChart from '@kaynooo/kayjs-ui/scatter-chart.kay'
import Segmented from '@kaynooo/kayjs-ui/segmented.kay'
import Select from '@kaynooo/kayjs-ui/select.kay'
import SidePanel from '@kaynooo/kayjs-ui/side-panel.kay'
import SiteFavicon from '@kaynooo/kayjs-ui/site-favicon.kay'
import SiteNav from '@kaynooo/kayjs-ui/site-nav.kay'
import Skeleton from '@kaynooo/kayjs-ui/skeleton.kay'
import SplitLayout from '@kaynooo/kayjs-ui/split-layout.kay'
import Stat from '@kaynooo/kayjs-ui/stat.kay'
import TabNav from '@kaynooo/kayjs-ui/tab-nav.kay'
import Table from '@kaynooo/kayjs-ui/table.kay'
import Tabs from '@kaynooo/kayjs-ui/tabs.kay'
import TextInput from '@kaynooo/kayjs-ui/text-input.kay'
import Textarea from '@kaynooo/kayjs-ui/textarea.kay'
import Toaster from '@kaynooo/kayjs-ui/toaster.kay'
import Toggle from '@kaynooo/kayjs-ui/toggle.kay'
import TooltipHost from '@kaynooo/kayjs-ui/tooltip-host.kay'
import TreeView from '@kaynooo/kayjs-ui/tree-view.kay'
import VirtualList from '@kaynooo/kayjs-ui/virtual-list.kay'
import WhenVisible from '@kaynooo/kayjs-ui/when-visible.kay'
import Widget from '@kaynooo/kayjs-ui/widget.kay'
import ZoomPane from '@kaynooo/kayjs-ui/zoom-pane.kay'

const noop = () => undefined
const action = Object.assign(async () => undefined, { pending: () => false, url: '/_kay/action/contract', error: () => undefined, succeeded: () => false })
const icon = 'plus'
const rows = [{ key: 'a', label: 'Mars', value: 2, display: 'two' }, { key: 'b', label: 'Venus', value: 1 }]
const tree = [{ id: 'mars', label: 'Mars', children: [{ id: 'phobos', label: 'Phobos' }] }, { id: 'venus', label: 'Venus' }]
const options = [{ value: 'mars', label: 'Mars' }, { value: 'earth', label: 'Earth' }]
const media = [{ key: 1, kind: 'image', thumb: '/a-thumb.png', preview: '/a.png' }, { key: 2, kind: 'image', thumb: '/b-thumb.png', preview: '/b.png' }]
const days = Array.from({ length: 14 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, value: index % 3, count: index % 3 }))
const columns = [{ key: 'name', header: 'Name', sortValue: true as const }, { key: 'moons', header: 'Moons', numeric: true as const }]
const planets = [{ name: 'Mars', moons: 2 }, { name: 'Earth', moons: 1 }]

// The component each file under `src` of the library exports, drawn by `components/contract.kay`.
export const COMPONENTS = {
  'accordion': Accordion,
  'app-header': AppHeader,
  'avatar': Avatar,
  'badge': Badge,
  'bar-list': BarList,
  'breadcrumb': Breadcrumb,
  'button': Button,
  'card-row': CardRow,
  'card': Card,
  'carousel': Carousel,
  'checkbox': Checkbox,
  'chip-group': ChipGroup,
  'collapsible-section': CollapsibleSection,
  'command-palette': CommandPalette,
  'confirm-delete': ConfirmDelete,
  'contact-form': ContactForm,
  'contribution-graph': ContributionGraph,
  'copy-button': CopyButton,
  'dialog': Dialog,
  'empty-state': EmptyState,
  'file-drop': FileDrop,
  'form-dialog': FormDialog,
  'form-field': FormField,
  'icon-button': IconButton,
  'icon-picker': IconPicker,
  'icon': Icon,
  'image-cropper': ImageCropper,
  'line-chart': LineChart,
  'load-more': LoadMore,
  'markdown-editor': MarkdownEditor,
  'masonry': Masonry,
  'media-gallery': MediaGallery,
  'menu': Menu,
  'meter': Meter,
  'multi-select': MultiSelect,
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
  'save-form': SaveForm,
  'scatter-chart': ScatterChart,
  'segmented': Segmented,
  'select': Select,
  'side-panel': SidePanel,
  'site-favicon': SiteFavicon,
  'site-nav': SiteNav,
  'split-layout': SplitLayout,
  'skeleton': Skeleton,
  'stat': Stat,
  'tab-nav': TabNav,
  'table': Table,
  'tabs': Tabs,
  'text-input': TextInput,
  'textarea': Textarea,
  'toaster': Toaster,
  'toggle': Toggle,
  'tooltip-host': TooltipHost,
  'tree-view': TreeView,
  'virtual-list': VirtualList,
  'when-visible': WhenVisible,
  'widget': Widget,
  'zoom-pane': ZoomPane,
} as unknown as Record<string, (props: Record<string, unknown>) => JSX.Element>

// Every component the library exports, with props that draw it.
export const CASES: Record<string, Record<string, unknown>> = {
  'accordion': { items: [{ value: 'mars', title: 'Mars' }, { value: 'venus', title: 'Venus', open: true }], panel: (value: string) => value },
  'app-header': { links: [{ href: '/', label: 'Home', icon }, { href: '/data', label: 'Data' }], current: '/data', label: 'Main', brand: 'Moons', end: 'Ada' },
  'avatar': { name: 'Grace', label: 'Grace' },
  'badge': { label: 'Draft', icon },
  'bar-list': { rows, onSelect: noop },
  'breadcrumb': { label: 'Trail', items: [{ label: 'Home', href: '/' }, { label: 'Moons' }] },
  'button': { label: 'Save', icon },
  'card-row': { left: 'L', right: 'R', actions: 'A', children: 'Mars' },
  'card': { title: 'Moons', children: 'Phobos' },
  'carousel': { slides: [{ src: '/a.png', alt: 'A' }, { src: '/b.png', alt: 'B' }] },
  'checkbox': { label: 'I agree', hint: 'v2' },
  'chip-group': { label: 'Decks', options, value: ['mars'] },
  'collapsible-section': { title: 'Older', boxed: true, children: 'Deimos' },
  'command-palette': { open: false, entries: [{ label: 'Home', group: 'Go', href: '/' }, { label: 'Do', group: 'Act', onSelect: noop }] },
  'confirm-delete': { message: 'Delete this?', failure: 'Could not delete', onConfirm: noop },
  'contact-form': { action, nameLabel: 'Name', emailLabel: 'Email', messageLabel: 'Message', submitLabel: 'Send' },
  'contribution-graph': { days, color: 'green', today: '2026-09-05' },
  'copy-button': { text: 'x', label: 'Copy link' },
  'dialog': { open: false, title: 'Rename', onOpenChange: noop, children: 'Body' },
  'empty-state': { title: 'No moons', description: 'Add one' },
  'file-drop': { 'aria-label': 'Photos', 'onFiles': noop, 'content': () => 'Drop files' },
  'form-dialog': { open: false, title: 'Rename', action, submitLabel: 'Save', failure: 'Failed', onOpenChange: noop },
  'form-field': { label: 'Name', hint: 'As shown', children: '' },
  'icon-button': { icon, label: 'Add' },
  'icon-picker': { search: async () => new Promise<never[]>(() => undefined), searchLabel: 'Search icons' },
  'icon': { icon, label: 'Add' },
  'image-cropper': { src: '/map.png' },
  'line-chart': { labels: ['a', 'b'], series: [{ name: 'Visits', values: [1, 2] }], label: 'Visits' },
  'load-more': { list: { rows: () => [], ended: () => false, failed: () => false, pending: () => false, retry: noop, loadMore: noop } },
  'markdown-editor': { 'value': '# Hi', 'aria-label': 'Body' },
  'masonry': { items: [1, 2], key: (item: number) => item, tile: (item: number) => String(item) },
  'media-gallery': { items: media },
  'menu': { items: [{ label: 'Edit', onSelect: noop }], label: 'Actions', icon },
  'meter': { value: 3, max: 10, label: 'Disk' },
  'multi-select': { options, label: 'Planets', value: ['mars'] },
  'notice': { children: 'Saved' },
  'page-header': { title: 'Moons', description: 'Every moon' },
  'page-section': { title: 'Moons', children: 'Phobos' },
  'pagination': { page: 2, pages: 5, url: '/posts' },
  'popover': { trigger: noop },
  'progress': { value: 40, label: 'Export' },
  'qr-code': { value: 'https://kaynooo.fr', label: 'Site' },
  'radio-group': { label: 'Planet', options, value: 'mars' },
  'range-input': { label: 'Hours', min: 0, max: 24 },
  'rating': { value: 4.5 },
  'save-form': { action, failure: 'Failed' },
  'scatter-chart': { points: [{ key: 'a', label: 'Hades', x: 1, y: 2 }], label: 'Games' },
  'segmented': { label: 'Range', options, value: 'mars' },
  'select': { 'aria-label': 'Planet', options, 'value': 'mars' },
  'side-panel': { open: false, title: 'Detail', onOpenChange: noop },
  'site-favicon': { name: 'kaynooo.fr' },
  'site-nav': { links: [{ href: '/', label: 'Home' }], current: '/', label: 'Main' },
  'split-layout': { list: 'L', detail: 'D' },
  'skeleton': { lines: 2, label: 'Loading' },
  'stat': { value: 12, label: 'moons' },
  'tab-nav': { links: [{ href: '/', label: 'Home' }], current: '/', label: 'Sections' },
  'table': { columns, rows: planets, rowKey: 'name' },
  'tabs': { tabs: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'a', label: 'Tabs', panel: (value: string) => value },
  'text-input': { 'aria-label': 'Name', 'value': '' },
  'textarea': { 'aria-label': 'Bio' },
  'toaster': {},
  'toggle': { label: 'Digest' },
  'tooltip-host': {},
  'tree-view': { nodes: tree, label: 'Planets', selected: 'phobos' },
  'virtual-list': { items: [1, 2, 3], item: (row: number) => String(row), label: 'Numbers' },
  'when-visible': { onVisible: noop },
  'widget': { title: 'Visits', children: '42' },
  'zoom-pane': { label: 'Map', children: 'Picture' },
}
