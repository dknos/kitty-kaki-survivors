// Node ESM loader hook: redirect `three` to the local stub for smoke tests.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = pathToFileURL(resolvePath(__dirname, '_three-stub.mjs')).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return { url: STUB, format: 'module', shortCircuit: true };
  return nextResolve(specifier, context);
}
