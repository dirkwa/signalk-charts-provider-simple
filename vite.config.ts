import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import dts from 'vite-plugin-dts';

const SRC = path.join(import.meta.dirname, 'src');

// Every module is its own entry: the raster worker is loaded by path at
// runtime, the catalog CLIs run as scripts, and the tests import single
// modules from dist/.
const entries = Object.fromEntries(
  fs
    .globSync('**/*.ts', { cwd: SRC })
    .filter((f) => !f.endsWith('.d.ts'))
    .map((f) => [f.slice(0, -'.ts'.length).replaceAll(path.sep, '/'), path.join(SRC, f)])
);

// The plugin is loaded by the Signal K server, so its dependencies stay
// external and resolve from node_modules at runtime rather than being
// bundled in beside the server's own copies.
const isExternal = (id: string): boolean =>
  !id.startsWith('.') && !path.isAbsolute(id) && !id.startsWith('\0');

export default defineConfig({
  // public/ is the webapp, served from the package as it is, not build input.
  publicDir: false,
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: entries,
      external: isExternal,
      output: {
        format: 'es',
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js'
      }
    }
  },
  // vite transpiles without type checking, so `vite build` alone would pass
  // source that tsc rejects. The checker runs tsc in the build and fails it on
  // the first error.
  plugins: [
    checker({ typescript: { tsconfigPath: './tsconfig.json' } }),
    dts({ tsconfigPath: './tsconfig.json', entryRoot: 'src' })
  ]
});
