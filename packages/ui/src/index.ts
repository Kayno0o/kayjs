// @kayjs/ui — Platform-first headless primitives + pure CSS Style Grammars.
// Zero JS recipes, zero Tailwind lock-in, zero custom compiler syntax.

export {
  createDataTable,
  createDialog,
  createTabs,
  findFirstEnabledIndex,
  findLastEnabledIndex,
  findNextEnabledIndex,
  handleListKeyDown,
  isDialogBackdropClick,
  nextUiId,
  syncDialogOpen,
} from './behaviors'
export type { DataTableOptions, DataTableState, DialogBehavior, ListNavigationOptions, TabsBehavior } from './behaviors'
export { toast } from './toast'
export type { ToastItem } from './toast'
export { CommandPalette } from './CommandPalette'
export type { CommandItem, CommandPaletteProps } from './CommandPalette'
export { DataTable } from './DataTable'
export type { DataTableColumn, DataTableProps } from './DataTable'
export { Dialog } from './Dialog'
export type { DialogProps } from './Dialog'
export { Drawer } from './Drawer'
export type { DrawerProps } from './Drawer'
export { Menu } from './Menu'
export type { MenuItemDef, MenuProps } from './Menu'
export {
  Accordion,
  AccordionItem,
  Badge,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  Grid,
  Popover,
  RadioGroup,
  Sidebar,
  Split,
  Switch,
} from './primitives'
export type { CheckControlProps, PopoverProps, RadioGroupProps, RadioOption } from './primitives'
export { Select } from './Select'
export type { SelectOption, SelectProps } from './Select'
export {
  Button,
  Cluster,
  Field,
  Notice,
  Stack,
} from './static'
export type {
  ButtonProps,
  ButtonVariant,
  FieldControlWiring,
  FieldProps,
  Size,
  SpaceToken,
  SpaceValue,
  Tone,
  TrackSize,
  TrackValue,
} from './static'
export { FieldContext, useFieldContext } from './static'
export { Tabs } from './Tabs'
export type { TabDef, TabsProps } from './Tabs'
export { Toaster } from './Toaster'
export type { ToasterProps } from './Toaster'
