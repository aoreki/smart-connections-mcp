/**
 * Parser for Smart Connections AJSON files. Format: one entry per line,
 * `"collection:key": {json},` — append semantics: later lines override earlier
 * ones, a null value deletes the key.
 *
 * Two on-disk layouts exist; both use this line format:
 * - legacy: `.smart-env/multi/*.ajson`, one `smart_blocks:` entry per block and
 *   vectors inlined at `embeddings.<modelKey>.vec`.
 * - newer: `.smart-env/smart_sources/smart_sources.ajson`, blocks nested in each
 *   source's `blocks_data` and vectors in sibling binary files (see binary-env.ts).
 */

import type { SmartBlock, SmartSource, VaultData } from './types.js';

export function createVaultData(): VaultData {
  return { sources: new Map(), blocks: new Map() };
}

export interface AjsonEntry {
  collection: string;
  key: string;
  value: unknown;
}

/** Split an AJSON file into `"collection:key": value` entries, in file order. */
export function readAjsonEntries(
  content: string,
  warn: (msg: string) => void = () => {},
): AjsonEntry[] {
  const out: AjsonEntry[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/,\s*$/, '');
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(`{${line}}`) as Record<string, unknown>;
    } catch {
      warn(`skipping unparseable line ${i + 1}`);
      continue;
    }
    for (const [rawKey, value] of Object.entries(obj)) {
      const sep = rawKey.indexOf(':');
      if (sep === -1) continue;
      out.push({ collection: rawKey.slice(0, sep), key: rawKey.slice(sep + 1), value });
    }
  }
  return out;
}

export function parseAjson(
  content: string,
  data: VaultData,
  warn: (msg: string) => void = () => {},
): void {
  for (const { collection, key, value } of readAjsonEntries(content, warn)) {
    if (collection === 'smart_sources') {
      if (value === null) {
        data.sources.delete(key);
      } else if (typeof value === 'object' && (value as SmartSource).path) {
        data.sources.set(key, value as SmartSource);
      }
    } else if (collection === 'smart_blocks') {
      if (value === null) {
        data.blocks.delete(key);
      } else if (typeof value === 'object') {
        const block = value as SmartBlock;
        block.key = block.key ?? key;
        data.blocks.set(key, block);
      }
    }
  }
}

/** Note path a block belongs to: portion of its key before the first '#'. */
export function blockNotePath(blockKey: string): string {
  const i = blockKey.indexOf('#');
  return i === -1 ? blockKey : blockKey.slice(0, i);
}

export function isFrontmatterBlock(blockKey: string): boolean {
  return blockKey.includes('#---frontmatter---');
}
