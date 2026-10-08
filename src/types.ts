/** Shapes of Smart Connections `.smart-env` data (v3.x) and server results. */

export interface EmbeddingData {
  vec?: number[];
}

/**
 * Newer Smart Connections (post-compaction) `.smart-env` layout: vectors live in
 * sibling binary files, not inline. An entry points at one row of one file.
 */
export interface EmbeddingRef {
  /** Binary file name inside the sibling directory, e.g. "mf_ccarbz". */
  file: string;
  /** Row index within that file: the vector starts at `file_i * dims * 4` bytes. */
  file_i: number;
}

/** `embedding.default` maps each binary vector file to the row holding the vector. */
export interface EmbeddingRefMap {
  history?: unknown[];
  default?: Record<string, EmbeddingRef>;
}

/** One block entry inside a source's `blocks_data` (newer layout). */
export interface SourceBlockData {
  /** Full block key, e.g. "Folder/Note.md#Heading#{1}". */
  key?: string;
  /** [startLine, endLine], 1-indexed inclusive */
  lines?: [number, number];
  size?: number;
  should_embed?: boolean;
  embedding?: EmbeddingRefMap;
}

/** A `smart_sources:` entry in `smart_sources/smart_sources.ajson` (newer layout). */
export interface BinarySmartSource {
  path: string;
  class_name?: string;
  embedding?: EmbeddingRefMap;
  /** heading key -> block metadata; key here never contains the note path. */
  blocks_data?: Record<string, SourceBlockData>;
  last_import?: { mtime?: number; size?: number };
  metadata?: Record<string, unknown>;
}

/** A row of `embedding_models/embedding_models.ajson`. */
export interface EmbeddingModelRecord {
  provider_key?: string;
  model_key?: string;
  /** Vector width — authoritative for slicing the binary files. */
  dims?: number;
  max_tokens?: number;
}

export interface SmartSource {
  path: string;
  class_name?: string;
  embeddings?: Record<string, EmbeddingData>;
  /** heading key -> [startLine, endLine], 1-indexed inclusive */
  blocks?: Record<string, [number, number]>;
  last_import?: { mtime?: number; size?: number };
  metadata?: Record<string, unknown>;
}

export interface SmartBlock {
  /** e.g. "Note.md##Heading#{2}" — always set (from the AJSON key if absent) */
  key: string;
  path?: string | null;
  class_name?: string;
  /** [startLine, endLine], 1-indexed inclusive */
  lines?: [number, number];
  embeddings?: Record<string, EmbeddingData>;
  size?: number;
}

export interface VaultData {
  /** note path -> source */
  sources: Map<string, SmartSource>;
  /** block key -> block */
  blocks: Map<string, SmartBlock>;
}

export interface SmartEnvConfig {
  smart_sources?: {
    embed_model?: { adapter?: string; [key: string]: unknown };
  };
  /** Present in the newer layout; names the `embedding_models` entry in use. */
  embedding_models?: { default_model_key?: string };
}

export interface SearchResult {
  path: string;
  vault: string;
  similarity: number;
  scope: 'note' | 'block';
  /** heading portion of the block key, e.g. "##Intro" — block hits only */
  block?: string;
  snippet: string;
  /** set on rows produced by keyword fallback; semantic rows omit it */
  match?: 'keyword';
}

export interface SearchResponse {
  mode: 'semantic' | 'keyword-fallback';
  warning?: string;
  results: SearchResult[];
}

export interface SimilarNote {
  path: string;
  vault: string;
  similarity: number;
  blocks: string[];
}

export interface ConnectionGraph {
  root: string;
  vault: string;
  connections: Array<{ path: string; depth: number; similarity: number }>;
}

export interface VaultInfo {
  name: string;
  path: string;
  status: 'ok' | 'error';
  error?: string;
  notes?: number;
  blocks?: number;
  indexed?: number;
  embeddingDim?: number;
  modelKey?: string;
  /** present only when smart_env.json's model_key was overridden by the data (see Vault.reconcileModelKey) */
  declaredModelKey?: string;
}
