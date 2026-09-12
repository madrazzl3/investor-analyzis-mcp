import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/stdio.ts'],
  format: ['esm'],
  // The workspace contracts package exports TypeScript source; bundle it so
  // dist runs on every supported Node version without type stripping.
  noExternal: ['@investor/contracts', 'jsonc-parser'],
});
