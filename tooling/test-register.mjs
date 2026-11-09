import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = new URL('./test-sdk.mjs', import.meta.url).href;
const aliases = new Set(['@flaretune/plugin-sdk', '@flaretune/plugin-sdk/pure', '@flaretune/plugin-sdk/client/i18n', '@flaretune/plugin-sdk/client/player-actions', '@flaretune/plugin-sdk/client/typewriter']);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@flaretune/plugin-sdk')) {
    if (!aliases.has(specifier)) throw new Error('Unknown test SDK alias: ' + specifier);
    return { url: sdk, shortCircuit: true };
  }
  if (specifier.startsWith('@flaretune/plugin-service/')) {
    const match = /^@flaretune\/plugin-service\/([a-z0-9-]+)\/(.+)$/u.exec(specifier);
    if (!match) throw new Error('Invalid test service');
    const path = resolve(root, 'plugins', match[1], match[2]);
    if (!path.startsWith(resolve(root, 'plugins', match[1]) + sep)) throw new Error('Invalid test service path');
    const parent = context.parentURL && fileURLToPath(context.parentURL).replaceAll('\\', '/');
    const owner = parent?.match(/\/plugins\/([a-z0-9-]+)\//u)?.[1];
    if (owner && owner !== match[1]) {
      const manifest = JSON.parse(readFileSync(resolve(root, 'plugins', owner, 'manifest.json'), 'utf8'));
      if (!manifest.dependencies?.[match[1]] && !manifest.optionalDependencies?.[match[1]]) throw new Error('Undeclared test service');
    }
    return { url: pathToFileURL(path).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
