import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runtimeStatic = resolve(process.env.GERT_CORE_ROOT || resolve(root, '..', 'gert'), 'internal', 'serve', 'static');
const common = { bundle: true, target: 'es2022', legalComments: 'eof', minify: true };
await Promise.all([
  build({ ...common, entryPoints: [resolve(root, 'scripts', 'highlighting-host-worker.ts')], outfile: resolve(root, 'out', 'highlighting-worker.cjs'), platform: 'node', format: 'cjs' }),
  build({ ...common, entryPoints: [resolve(root, 'webview', 'highlighting', 'worker.ts')], outfile: resolve(root, 'media', 'highlighting-worker.js'), platform: 'browser', format: 'esm' }),
  ...(process.env.GERT_BUILD_CORE_ASSETS === '1' ? [
    build({ ...common, entryPoints: [resolve(root, 'webview', 'highlighting', 'worker.ts')], outfile: resolve(runtimeStatic, 'highlighting', 'worker.js'), platform: 'browser', format: 'esm' }),
    build({ ...common, entryPoints: [resolve(root, 'webview', 'highlighting', 'highlighter.ts')], outfile: resolve(runtimeStatic, 'highlighting', 'highlighter.js'), platform: 'browser', format: 'esm' }),
  ] : []),
]);
const css = await readFile(resolve(root, 'node_modules', 'reactflow', 'dist', 'style.css'), 'utf8');
if (process.env.GERT_BUILD_CORE_ASSETS === '1') await build({ ...common, stdin: {
  resolveDir: root, sourcefile: 'offline-preview-vendor.js', loader: 'js',
  contents: `export { default as React, useEffect, useMemo, useState, useCallback, useRef } from 'react';
export { createRoot } from 'react-dom/client';
export { default as ReactFlow, Background, Controls, MiniMap, Handle, Position, ReactFlowProvider, useReactFlow } from 'reactflow';
export { default as dagre } from '@dagrejs/dagre';
export { marked } from 'marked';
export { default as DOMPurify } from 'dompurify';
const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style);`,
}, outfile: resolve(runtimeStatic, 'vendor', 'preview.js'), platform: 'browser', format: 'esm' });
const packages = ['shiki', '@shikijs/core', '@shikijs/engine-javascript', '@shikijs/vscode-textmate', '@shikijs/langs', '@shikijs/themes', 'oniguruma-to-es', 'oniguruma-parser', 'regex', 'regex-recursion', 'regex-utilities', 'yaml'];
let notices = 'Offline code presentation: pinned Shiki 3.12.2, JavaScript regex engine, SQL/Kusto/PowerShell grammars and bundled palettes.\nSelected grammar modules: @shikijs/langs/dist/{sql,kusto,powershell}.mjs, distributed under the package MIT license reproduced below. No grammar is fetched at runtime.\n\n';
for (const name of packages) {
  const dir = resolve(root, 'node_modules', name);
  let license;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try { license = await readFile(resolve(dir, file), 'utf8'); break; } catch {}
  }
  if (!license) throw new Error(`Missing license: ${name}`);
  notices += `\n===== ${name} =====\n${license}\n`;
}
await writeFile(resolve(root, 'media', 'highlighting-NOTICES.txt'), notices);
// Package real runtime dependencies, never the development node_modules junction.
for (const name of ['yaml', 'js-yaml', 'argparse']) {
  await cp(resolve(root, 'node_modules', name), resolve(root, 'out', 'node_modules', name), { recursive: true });
}
