// esbuild loads .svg files as text (see build.mjs).
declare module '*.svg' {
  const content: string;
  export default content;
}
