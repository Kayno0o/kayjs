// @kayjs/ui — Platform-first headless primitives + pure CSS Style Grammars.
// Zero JS recipes, zero Tailwind lock-in, zero custom compiler syntax.

export { createDataTable, createDialog, createTabs, toast } from './behaviors'
export type { DataTableOptions, DataTableState, DialogBehavior, TabsBehavior, ToastItem } from './behaviors'
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
export { Select } from './Select'
export type { SelectOption, SelectProps } from './Select'
export {
  Accordion,
  AccordionItem,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  Cluster,
  Field,
  Grid,
  Notice,
  Popover,
  RadioGroup,
  Sidebar,
  Split,
  Stack,
  Switch,
} from './static'
export type { ButtonProps, ButtonVariant, CheckControlProps, FieldProps, PopoverProps, RadioGroupProps, RadioOption, Size, Tone } from './static'
export { Tabs } from './Tabs'
export type { TabDef, TabsProps } from './Tabs'
export { Toaster } from './Toaster'
