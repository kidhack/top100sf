import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Single ESM file with CodeMirror inlined (no esm.sh at runtime). */
export async function bundleListItemsEditor(outfile, logLevel = 'warning') {
  await esbuild.build({
    entryPoints: [join(root, 'list-items-editor.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile,
    logLevel,
  });
}
