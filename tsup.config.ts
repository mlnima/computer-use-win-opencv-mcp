import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  external: [
    '@lydell/node-pty',
    '@modelcontextprotocol/sdk',
    '@screen-capture/node',
    '@techstark/opencv-js',
    'express',
    'sharp',
    'tesseract.js',
    'zod'
  ]
});
