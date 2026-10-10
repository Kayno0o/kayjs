// Written by docs/demos.ts from src/ui-examples: run `bun docs/demos.ts` after adding or removing an example.
import type { SafeHtml } from 'kay'
import { join } from 'node:path'
import { highlightCode } from 'kay/content'
import { highlight } from './highlight'
import BadgeBasic from './ui-examples/badge/basic.kay'
import BadgeIcon from './ui-examples/badge/icon.kay'
import BadgeTones from './ui-examples/badge/tones.kay'
import BarListBasic from './ui-examples/bar-list/basic.kay'
import BarListEmpty from './ui-examples/bar-list/empty.kay'
import BarListSelect from './ui-examples/bar-list/select.kay'
import ButtonBasic from './ui-examples/button/basic.kay'
import ButtonBusy from './ui-examples/button/busy.kay'
import ButtonIcon from './ui-examples/button/icon.kay'
import ButtonLink from './ui-examples/button/link.kay'
import ButtonVariants from './ui-examples/button/variants.kay'
import CardRowBasic from './ui-examples/card-row/basic.kay'
import CardRowSlots from './ui-examples/card-row/slots.kay'
import CardBare from './ui-examples/card/bare.kay'
import CardBasic from './ui-examples/card/basic.kay'
import CardHead from './ui-examples/card/head.kay'
import CarouselAutoplay from './ui-examples/carousel/autoplay.kay'
import CarouselBasic from './ui-examples/carousel/basic.kay'
import CollapsibleSectionBasic from './ui-examples/collapsible-section/basic.kay'
import CollapsibleSectionBoxed from './ui-examples/collapsible-section/boxed.kay'
import CommandPaletteBasic from './ui-examples/command-palette/basic.kay'
import ConfirmDeleteBasic from './ui-examples/confirm-delete/basic.kay'
import ConfirmDeleteButton from './ui-examples/confirm-delete/button.kay'
import ConfirmDeleteFailure from './ui-examples/confirm-delete/failure.kay'
import ContributionGraphBasic from './ui-examples/contribution-graph/basic.kay'
import CopyButtonBasic from './ui-examples/copy-button/basic.kay'
import CopyButtonHtml from './ui-examples/copy-button/html.kay'
import DialogBasic from './ui-examples/dialog/basic.kay'
import EmptyStateBasic from './ui-examples/empty-state/basic.kay'
import FileDropBasic from './ui-examples/file-drop/basic.kay'
import FormFieldBasic from './ui-examples/form-field/basic.kay'
import FormFieldIssue from './ui-examples/form-field/issue.kay'
import IconButtonBasic from './ui-examples/icon-button/basic.kay'
import IconButtonCustom from './ui-examples/icon-button/custom.kay'
import IconButtonSizes from './ui-examples/icon-button/sizes.kay'
import IconButtonVariants from './ui-examples/icon-button/variants.kay'
import IconPickerBasic from './ui-examples/icon-picker/basic.kay'
import IconBasic from './ui-examples/icon/basic.kay'
import IconImported from './ui-examples/icon/imported.kay'
import ImageCropperBasic from './ui-examples/image-cropper/basic.kay'
import ImageCropperFooter from './ui-examples/image-cropper/footer.kay'
import LineChartBasic from './ui-examples/line-chart/basic.kay'
import LineChartFormatted from './ui-examples/line-chart/formatted.kay'
import LineChartRange from './ui-examples/line-chart/range.kay'
import MarkdownEditorBasic from './ui-examples/markdown-editor/basic.kay'
import MarkdownEditorUpload from './ui-examples/markdown-editor/upload.kay'
import MasonryBasic from './ui-examples/masonry/basic.kay'
import MediaGalleryBasic from './ui-examples/media-gallery/basic.kay'
import MediaGalleryControlled from './ui-examples/media-gallery/controlled.kay'
import MenuBasic from './ui-examples/menu/basic.kay'
import MeterBasic from './ui-examples/meter/basic.kay'
import MeterThresholds from './ui-examples/meter/thresholds.kay'
import MultiSelectBasic from './ui-examples/multi-select/basic.kay'
import MultiSelectSearch from './ui-examples/multi-select/search.kay'
import PageSectionBasic from './ui-examples/page-section/basic.kay'
import PaginationBasic from './ui-examples/pagination/basic.kay'
import PaginationOptions from './ui-examples/pagination/options.kay'
import PopoverBasic from './ui-examples/popover/basic.kay'
import PopoverControlled from './ui-examples/popover/controlled.kay'
import QrCodeBasic from './ui-examples/qr-code/basic.kay'
import QrCodeStyled from './ui-examples/qr-code/styled.kay'
import RangeInputBasic from './ui-examples/range-input/basic.kay'
import RatingBasic from './ui-examples/rating/basic.kay'
import ScatterChartBasic from './ui-examples/scatter-chart/basic.kay'
import SegmentedBasic from './ui-examples/segmented/basic.kay'
import SegmentedBusy from './ui-examples/segmented/busy.kay'
import SelectBasic from './ui-examples/select/basic.kay'
import SelectLoading from './ui-examples/select/loading.kay'
import SidePanelActions from './ui-examples/side-panel/actions.kay'
import SidePanelBasic from './ui-examples/side-panel/basic.kay'
import SiteFaviconBasic from './ui-examples/site-favicon/basic.kay'
import SiteNavBasic from './ui-examples/site-nav/basic.kay'
import SplitLayoutBasic from './ui-examples/split-layout/basic.kay'
import SplitLayoutResizable from './ui-examples/split-layout/resizable.kay'
import StatBasic from './ui-examples/stat/basic.kay'
import StatWithIcon from './ui-examples/stat/with-icon.kay'
import TabNavBasic from './ui-examples/tab-nav/basic.kay'
import TableBasic from './ui-examples/table/basic.kay'
import TableEmpty from './ui-examples/table/empty.kay'
import TabsBasic from './ui-examples/tabs/basic.kay'
import TextInputBasic from './ui-examples/text-input/basic.kay'
import TextInputTypes from './ui-examples/text-input/types.kay'
import ToasterBasic from './ui-examples/toaster/basic.kay'
import ToggleBasic from './ui-examples/toggle/basic.kay'
import ToggleBusy from './ui-examples/toggle/busy.kay'
import TooltipHostBasic from './ui-examples/tooltip-host/basic.kay'
import WhenVisibleBasic from './ui-examples/when-visible/basic.kay'
import WidgetBasic from './ui-examples/widget/basic.kay'
import WidgetEmpty from './ui-examples/widget/empty.kay'
import ZoomPaneBasic from './ui-examples/zoom-pane/basic.kay'

const components = {
  'badge/basic': BadgeBasic,
  'badge/icon': BadgeIcon,
  'badge/tones': BadgeTones,
  'bar-list/basic': BarListBasic,
  'bar-list/empty': BarListEmpty,
  'bar-list/select': BarListSelect,
  'button/basic': ButtonBasic,
  'button/busy': ButtonBusy,
  'button/icon': ButtonIcon,
  'button/link': ButtonLink,
  'button/variants': ButtonVariants,
  'card-row/basic': CardRowBasic,
  'card-row/slots': CardRowSlots,
  'card/bare': CardBare,
  'card/basic': CardBasic,
  'card/head': CardHead,
  'carousel/autoplay': CarouselAutoplay,
  'carousel/basic': CarouselBasic,
  'collapsible-section/basic': CollapsibleSectionBasic,
  'collapsible-section/boxed': CollapsibleSectionBoxed,
  'command-palette/basic': CommandPaletteBasic,
  'confirm-delete/basic': ConfirmDeleteBasic,
  'confirm-delete/button': ConfirmDeleteButton,
  'confirm-delete/failure': ConfirmDeleteFailure,
  'contribution-graph/basic': ContributionGraphBasic,
  'copy-button/basic': CopyButtonBasic,
  'copy-button/html': CopyButtonHtml,
  'dialog/basic': DialogBasic,
  'empty-state/basic': EmptyStateBasic,
  'file-drop/basic': FileDropBasic,
  'form-field/basic': FormFieldBasic,
  'form-field/issue': FormFieldIssue,
  'icon-button/basic': IconButtonBasic,
  'icon-button/custom': IconButtonCustom,
  'icon-button/sizes': IconButtonSizes,
  'icon-button/variants': IconButtonVariants,
  'icon-picker/basic': IconPickerBasic,
  'icon/basic': IconBasic,
  'icon/imported': IconImported,
  'image-cropper/basic': ImageCropperBasic,
  'image-cropper/footer': ImageCropperFooter,
  'line-chart/basic': LineChartBasic,
  'line-chart/formatted': LineChartFormatted,
  'line-chart/range': LineChartRange,
  'markdown-editor/basic': MarkdownEditorBasic,
  'markdown-editor/upload': MarkdownEditorUpload,
  'masonry/basic': MasonryBasic,
  'media-gallery/basic': MediaGalleryBasic,
  'media-gallery/controlled': MediaGalleryControlled,
  'menu/basic': MenuBasic,
  'meter/basic': MeterBasic,
  'meter/thresholds': MeterThresholds,
  'multi-select/basic': MultiSelectBasic,
  'multi-select/search': MultiSelectSearch,
  'page-section/basic': PageSectionBasic,
  'pagination/basic': PaginationBasic,
  'pagination/options': PaginationOptions,
  'popover/basic': PopoverBasic,
  'popover/controlled': PopoverControlled,
  'qr-code/basic': QrCodeBasic,
  'qr-code/styled': QrCodeStyled,
  'range-input/basic': RangeInputBasic,
  'rating/basic': RatingBasic,
  'scatter-chart/basic': ScatterChartBasic,
  'segmented/basic': SegmentedBasic,
  'segmented/busy': SegmentedBusy,
  'select/basic': SelectBasic,
  'select/loading': SelectLoading,
  'side-panel/actions': SidePanelActions,
  'side-panel/basic': SidePanelBasic,
  'site-favicon/basic': SiteFaviconBasic,
  'site-nav/basic': SiteNavBasic,
  'split-layout/basic': SplitLayoutBasic,
  'split-layout/resizable': SplitLayoutResizable,
  'stat/basic': StatBasic,
  'stat/with-icon': StatWithIcon,
  'tab-nav/basic': TabNavBasic,
  'table/basic': TableBasic,
  'table/empty': TableEmpty,
  'tabs/basic': TabsBasic,
  'text-input/basic': TextInputBasic,
  'text-input/types': TextInputTypes,
  'toaster/basic': ToasterBasic,
  'toggle/basic': ToggleBasic,
  'toggle/busy': ToggleBusy,
  'tooltip-host/basic': TooltipHostBasic,
  'when-visible/basic': WhenVisibleBasic,
  'widget/basic': WidgetBasic,
  'widget/empty': WidgetEmpty,
  'zoom-pane/basic': ZoomPaneBasic,
}

export type DemoName = keyof typeof components

const source = async (name: string) => highlightCode((await Bun.file(join(import.meta.dir, 'ui-examples', `${name}.kay`)).text()).trimEnd(), 'kay', { highlight })

export const demos = Object.fromEntries(await Promise.all(Object.entries(components).map(async ([name, component]) => [name, { component, html: await source(name) }]))) as Record<DemoName, { component: typeof components[DemoName], html: SafeHtml }>
