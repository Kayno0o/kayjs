// A `.kay` file the library's own tests import by name: the library's check has no shadow tree for it, so any one is a component taking props.
declare module '*.kay' {
  // eslint-disable-next-line ts/no-explicit-any -- the props of any component, which a function type taking `never` or `unknown` would not accept
  const component: (props: any) => JSX.Element

  export default component
}
