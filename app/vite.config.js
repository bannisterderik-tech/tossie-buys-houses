import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The app and the marketing site share one brand. Rather than copy the palette
// into a second place where it can drift, read data/business.json at build time
// and inject it — the same file gen/build.mjs generates the public site from.
const BIZ = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'business.json'), 'utf8'));

export default defineConfig({
  plugins: [react()],
  // Served under /app/ on the same domain as the marketing site.
  base: '/app/',
  // Built straight into the static output the site deploys from. site/ is
  // gitignored, so nothing here lands in git.
  build: {
    outDir: path.join(ROOT, 'site', 'app'),
    emptyOutDir: true,
  },
  define: {
    __BRAND__: JSON.stringify(BIZ.brand),
    __BIZ__: JSON.stringify({
      name: BIZ.name,
      logo: BIZ.logo,
      phoneDisplay: BIZ.phoneDisplay,
    }),
  },
  server: { port: 5174 },
});
