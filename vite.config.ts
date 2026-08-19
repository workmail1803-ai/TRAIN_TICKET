import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Three build modes, because a Chrome extension needs three different output shapes:
 *
 *   default  -> popup.html + options.html, bundled as ES modules, `public/` copied to dist/
 *   content  -> ONE self-contained IIFE. Content scripts cannot be ES modules.
 *   sw       -> ES module service worker (manifest declares "type": "module").
 *
 * `npm run build` runs all three in order. Only the first empties dist/.
 */
export default defineConfig(({ mode }) => {
  const common = {
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    // Chrome 114+ is the MV3 baseline we target. Keeps output small and avoids
    // transpiling away features the browser already has.
    build: { target: 'chrome114' as const, minify: false as const, sourcemap: true },
  };

  if (mode === 'content') {
    return {
      ...common,
      build: {
        ...common.build,
        outDir: 'dist',
        emptyOutDir: false,
        lib: {
          entry: resolve(__dirname, 'src/content/bootstrap.ts'),
          name: 'RailwayQuickBook',
          formats: ['iife'],
          fileName: () => 'content.js',
        },
      },
    };
  }

  if (mode === 'sw') {
    return {
      ...common,
      build: {
        ...common.build,
        outDir: 'dist',
        emptyOutDir: false,
        lib: {
          entry: resolve(__dirname, 'src/background/service-worker.ts'),
          formats: ['es'],
          fileName: () => 'service-worker.js',
        },
      },
    };
  }

  return {
    ...common,
    build: {
      ...common.build,
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          popup: resolve(__dirname, 'src/popup/popup.html'),
          options: resolve(__dirname, 'src/options/options.html'),
        },
      },
    },
  };
});
