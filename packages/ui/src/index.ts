// @kayjs/ui — Platform-first headless primitives + pure CSS Style Grammars.
// Zero JS recipes, zero Tailwind lock-in, zero custom compiler syntax.

export { createDataTable, createDialog, createTabs, toast } from './behaviors'
export type { DataTableOptions, DataTableState, DialogBehavior, TabsBehavior, ToastItem } from './behaviors'
export { Dialog } from './Dialog'
export type { DialogProps } from './Dialog'
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
  Cluster,
  Field,
  Grid,
  Notice,
  Popover,
  Sidebar,
  Split,
  Stack,
} from './static'
export type { ButtonProps, ButtonVariant, FieldProps, PopoverProps, Size, Tone } from './static'
export { Tabs } from './Tabs'
export type { TabDef, TabsProps } from './Tabs'
export { Toaster } from './Toaster'
