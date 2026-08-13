import { defineConfig } from 'tsdown'

/**
 * Bundle the two main-process-side entries the way every workspace package is
 * built: tsc emits JavaScript into lib/types, tsdown turns it into the runtime
 * artifact. `electron` is provided by the runtime, and `electron-updater` stays
 * a real dependency so electron-builder collects it into the asar unbundled.
 *
 * The preload emits CommonJS under a `.cjs` extension: a sandboxed renderer
 * cannot load an ES module preload, and this package is `"type": "module"`.
 */
export default defineConfig([
  {
    entry: ['lib/types/src/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron', 'electron-updater'] },
  },
  {
    entry: ['lib/types/src/preload.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: true,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
])
