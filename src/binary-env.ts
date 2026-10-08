/**
 * Loader for the newer Smart Connections `.smart-env` layout.
 *
 * Instead of `multi/*.ajson` with inline vectors, the plugin now writes:
 *
 *   .smart-env/smart_env.json                              # config (+ embedding_models.default_model_key)
 *   .smart-env/embedding_models/embedding_models.ajson     # "embedding_models:<key>": {model_key, dims, ...}
 *   .smart-env/smart_sources/smart_sources.ajson           # "smart_sources:<path>": {...}
 *   .smart-env/smart_sources/<file>                        # binary float32 rows (note vectors)
 *   .smart-env/smart_blocks/<file>                         # binary float32 rows (block vectors)
 *
 * A source no longer stores a vector inline; it stores a reference —
 * `embedding.default.<file>: {file, file_i}` — to row `file_i` of that binary
 * file. Blocks live in the source's `blocks_data` (keyed by heading), each with
 * its own line range and optional embedding reference into `smart_blocks/`.
 *
 * This module resolves those references into the normalized `VaultData` shape the
 * rest of the server already speaks: inline vectors keyed by model key.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readAjsonEntries } from './ajson-loader.js';
import type {
  BinarySmartSource,
  EmbeddingModelRecord,
  EmbeddingRef,
  EmbeddingRefMap,
  SmartEnvConfig,
  SmartSource,
  VaultData,
} from './types.js';
import { VectorFileReader } from './vector-file.js';

export const SOURCES_DIR = 'smart_sources';
export const BLOCKS_DIR = 'smart_blocks';
export const EMBEDDING_MODELS_DIR = 'embedding_models';
export const SOURCES_AJSON = 'smart_sources.ajson';
export const EMBEDDING_MODELS_AJSON = 'embedding_models.ajson';

/** The source file whose presence marks the newer layout. */
export function sourcesAjsonPath(smartEnvDir: string): string {
  return path.join(smartEnvDir, SOURCES_DIR, SOURCES_AJSON);
}

export function hasBinaryLayout(smartEnvDir: string): boolean {
  return fs.existsSync(sourcesAjsonPath(smartEnvDir));
}

export interface BinaryEnvResult {
  /** Model key the loaded vectors were stored under. */
  modelKey: string;
  dims: number;
}

/** First usable row reference of an `embedding` object, regardless of file key. */
function firstRef(embedding?: EmbeddingRefMap): EmbeddingRef | undefined {
  const entries = Object.values(embedding?.default ?? {});
  for (const ref of entries) {
    if (ref && typeof ref.file === 'string' && Number.isInteger(ref.file_i)) return ref;
  }
  return undefined;
}

/**
 * Resolve the model key and vector width. `embedding_models.ajson` is
 * authoritative; `smart_env.json` is only a fallback because it can lag behind
 * the data (issue #9).
 */
function resolveModel(
  smartEnvDir: string,
  config: SmartEnvConfig,
  declaredModelKey: string,
  warn: (msg: string) => void,
): { modelKey: string; dims?: number } {
  const modelsPath = path.join(smartEnvDir, EMBEDDING_MODELS_DIR, EMBEDDING_MODELS_AJSON);
  if (!fs.existsSync(modelsPath)) return { modelKey: declaredModelKey };

  let records: Array<{ key: string; value: EmbeddingModelRecord }>;
  try {
    records = readAjsonEntries(fs.readFileSync(modelsPath, 'utf-8'), warn)
      .filter((e) => e.collection === 'embedding_models' && e.value !== null && typeof e.value === 'object')
      .map((e) => ({ key: e.key, value: e.value as EmbeddingModelRecord }));
  } catch (e) {
    warn(`${EMBEDDING_MODELS_AJSON}: ${e instanceof Error ? e.message : String(e)}`);
    return { modelKey: declaredModelKey };
  }

  const defaultKey = config.embedding_models?.default_model_key;
  const chosen =
    records.find((r) => r.key === defaultKey) ??
    records.find((r) => r.value.model_key === declaredModelKey) ??
    records.find((r) => typeof r.value.model_key === 'string');

  if (!chosen) return { modelKey: declaredModelKey };
  return {
    modelKey: typeof chosen.value.model_key === 'string' ? chosen.value.model_key : declaredModelKey,
    dims: typeof chosen.value.dims === 'number' && chosen.value.dims > 0 ? chosen.value.dims : undefined,
  };
}

/**
 * Last-resort vector width: with `n+1` rows in a file of `size` bytes, each row
 * is `size / (n+1)` bytes wide, so dims = that divided by 4.
 */
function inferDims(smartEnvDir: string, refs: EmbeddingRef[], dirs: string[]): number {
  const rows = new Map<string, number>();
  refs.forEach((ref, i) => {
    const rel = `${dirs[i]}/${ref.file}`;
    rows.set(rel, Math.max(rows.get(rel) ?? -1, ref.file_i));
  });
  for (const [rel, maxRow] of rows) {
    try {
      const size = fs.statSync(path.join(smartEnvDir, rel)).size;
      const count = maxRow + 1;
      if (size > 0 && size % (4 * count) === 0) return size / (4 * count);
    } catch {
      // file missing; try the next one
    }
  }
  return 0;
}

/** Populate `data` from the newer layout. Assumes `hasBinaryLayout` is true. */
export function loadBinaryEnv(
  smartEnvDir: string,
  data: VaultData,
  config: SmartEnvConfig,
  declaredModelKey: string,
  warn: (msg: string) => void = () => {},
): BinaryEnvResult {
  const { modelKey, dims: declaredDims } = resolveModel(smartEnvDir, config, declaredModelKey, warn);

  const entries = readAjsonEntries(
    fs.readFileSync(sourcesAjsonPath(smartEnvDir), 'utf-8'),
    warn,
  ).filter((e) => e.collection === 'smart_sources');

  // Append semantics: later lines win, null deletes.
  const sources = new Map<string, BinarySmartSource>();
  for (const e of entries) {
    if (e.value === null) {
      sources.delete(e.key);
      continue;
    }
    const value = e.value as BinarySmartSource;
    if (value && typeof value === 'object' && typeof value.path === 'string') {
      sources.set(value.path, value);
    }
  }

  // Collect every reference so a missing `embedding_models` file can still be
  // recovered from the binary sizes.
  const refs: EmbeddingRef[] = [];
  const dirs: string[] = [];
  for (const source of sources.values()) {
    const noteRef = firstRef(source.embedding);
    if (noteRef) {
      refs.push(noteRef);
      dirs.push(SOURCES_DIR);
    }
    for (const block of Object.values(source.blocks_data ?? {})) {
      const blockRef = firstRef(block?.embedding);
      if (blockRef) {
        refs.push(blockRef);
        dirs.push(BLOCKS_DIR);
      }
    }
  }

  const dims = declaredDims ?? inferDims(smartEnvDir, refs, dirs);
  if (dims <= 0) {
    warn(
      `could not determine vector width — no usable dims in ${EMBEDDING_MODELS_AJSON} and no references to infer from`,
    );
  }
  const reader = new VectorFileReader(dims, (m) => warn(m));

  for (const [notePath, source] of sources) {
    data.sources.set(notePath, buildSource(notePath, source, modelKey, dims, smartEnvDir, reader));
    for (const [heading, block] of Object.entries(source.blocks_data ?? {})) {
      const key = block?.key ?? `${notePath}${heading}`;
      const ref = firstRef(block?.embedding);
      const vec = ref ? reader.read(path.join(smartEnvDir, BLOCKS_DIR, ref.file), ref.file_i) : undefined;
      if (!vec?.length) continue;
      data.blocks.set(key, {
        key,
        path: null,
        class_name: 'SmartBlock',
        ...(block?.lines ? { lines: block.lines } : {}),
        embeddings: { [modelKey]: { vec } },
        ...(typeof block?.size === 'number' ? { size: block.size } : {}),
      });
    }
  }

  return { modelKey, dims };
}

function buildSource(
  notePath: string,
  source: BinarySmartSource,
  modelKey: string,
  dims: number,
  smartEnvDir: string,
  reader: VectorFileReader,
): SmartSource {
  const blocks: Record<string, [number, number]> = {};
  for (const [heading, block] of Object.entries(source.blocks_data ?? {})) {
    if (block?.lines) blocks[heading] = block.lines;
  }

  const noteRef = firstRef(source.embedding);
  const vec = noteRef ? reader.read(path.join(smartEnvDir, SOURCES_DIR, noteRef.file), noteRef.file_i) : undefined;

  return {
    path: notePath,
    class_name: source.class_name ?? 'SmartSource',
    ...(vec?.length === dims ? { embeddings: { [modelKey]: { vec } } } : {}),
    blocks,
    ...(source.last_import ? { last_import: source.last_import } : {}),
    ...(source.metadata ? { metadata: source.metadata } : {}),
  };
}

/** Files whose change should trigger a reload of a newer-layout vault. */
export function binaryFileStates(smartEnvDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of [SOURCES_DIR, BLOCKS_DIR, EMBEDDING_MODELS_DIR]) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(smartEnvDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(smartEnvDir, dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) out.set(`${dir}/${name}`, `${st.mtimeMs}:${st.size}`);
      } catch {
        // raced with a write; the next check will see it
      }
    }
  }
  return out;
}