import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Vault } from '../src/vault.js';
import { VectorFileReader } from '../src/vector-file.js';
import { SearchEngine, type QueryEmbedder } from '../src/search-engine.js';
import { VaultRegistry } from '../src/vault-registry.js';
import { BlockNotFoundError, EmbedUnavailableError } from '../src/errors.js';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/vault-binary');
const SMART_ENV = path.join(FIXTURE, '.smart-env');
const SOURCES_AJSON = path.join(SMART_ENV, 'smart_sources', 'smart_sources.ajson');
const SOURCES_BIN = path.join(SMART_ENV, 'smart_sources', 'testbin');
const DIMS = 8;
/** Vault.lastCheck starts at 0, so explicit timestamps must clear the 2s throttle. */
const T0 = 10_000_000;

const E1 = [1, 0, 0, 0, 0, 0, 0, 0];
const E3 = [0, 0, 1, 0, 0, 0, 0, 0];

/** Fake: queries containing "alpha" → e1, otherwise → e3. */
const fakeEmbedder: QueryEmbedder = {
  getEmbedFn: async () => async (text: string) => (text.includes('alpha') ? E1 : E3),
};

const offlineEmbedder: QueryEmbedder = {
  getEmbedFn: async () => {
    throw new EmbedUnavailableError('offline');
  },
};

function writeVectors(file: string, rows: number[][]): void {
  const buf = Buffer.alloc(rows.length * DIMS * 4);
  rows.forEach((row, r) => row.forEach((val, i) => buf.writeFloatLE(val, (r * DIMS + i) * 4)));
  fs.writeFileSync(file, buf);
}

describe('newer .smart-env layout (binary vector files)', () => {
  it('resolves row references into note and block embeddings', () => {
    const v = Vault.load(FIXTURE, 'vault-binary');
    expect(v.modelKey).toBe('test-model-8d');
    const s = v.stats();
    // Alpha, Gamma, Plain (never embedded), OutOfRange (ref beyond EOF)
    expect(s.notes).toBe(4);
    // Only #Intro and #Detail carry vectors; frontmatter has should_embed:false
    expect(s.blocks).toBe(2);
    expect(s.indexed).toBe(4);
    expect(s.embeddingDim).toBe(8);
  });

  it('drops a null source entry and its blocks', () => {
    const v = Vault.load(FIXTURE, 'vault-binary');
    expect(v.data.sources.has('Gone.md')).toBe(false);
  });

  it('reads chunks through the blocks_data line ranges', () => {
    const v = Vault.load(FIXTURE, 'vault-binary');
    expect(v.extractBlockByHeading('Alpha.md', '#Intro')).toBe(
      '## Intro\nAlpha intro text about apples.\nMore intro.',
    );
    expect(v.blockSnippet('Alpha.md#Intro')).toContain('Alpha intro text');
    expect(v.noteSnippet('Alpha.md').startsWith('# Alpha')).toBe(true); // frontmatter stripped
    expect(() => v.extractBlockByHeading('Alpha.md', '#Nope')).toThrow(BlockNotFoundError);
  });

  it('lists every heading, embedded or not, for get_note_content', () => {
    const engine = new SearchEngine(VaultRegistry.fromPaths([FIXTURE]), fakeEmbedder);
    const note = engine.getNoteContent('Alpha.md') as { blocks: string[] };
    expect(note.blocks).toEqual(['#---frontmatter---', '#Intro', '#Detail']);

    const part = engine.getNoteContent('Alpha.md', { includeBlocks: ['#Intro'] }) as {
      extracted: Record<string, string>;
      missing: string[];
    };
    expect(part.extracted['#Intro']).toContain('about apples');
    expect(part.missing).toEqual([]);
  });

  it('search ranks note and block vectors read from the binary files', async () => {
    const engine = new SearchEngine(VaultRegistry.fromPaths([FIXTURE]), fakeEmbedder);
    const res = await engine.search('alpha ideas', { threshold: 0.4 });
    expect(res.mode).toBe('semantic');
    expect(res.results.map((r) => `${r.path}${r.block ?? ''}`)).toEqual([
      'Alpha.md',
      'Alpha.md#Intro', // 0.8
    ]);
    expect(res.results[1].scope).toBe('block');
    expect(res.results[1].snippet).toContain('Alpha intro text');
  });

  it('still degrades to keyword matching when the model cannot load', async () => {
    const engine = new SearchEngine(VaultRegistry.fromPaths([FIXTURE]), offlineEmbedder);
    const res = await engine.search('gadgets');
    expect(res.mode).toBe('keyword-fallback');
    expect(res.results[0].path).toBe('Gamma.md');
  });

  it('rejects a vault with neither layout present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scmcp-empty-'));
    try {
      fs.mkdirSync(path.join(tmp, '.smart-env'));
      fs.writeFileSync(
        path.join(tmp, '.smart-env', 'smart_env.json'),
        JSON.stringify({ smart_sources: { embed_model: { adapter: 'transformers', transformers: { model_key: 'x' } } } }),
      );
      expect(() => Vault.load(tmp, 'empty')).toThrow(/smart_sources/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('VectorFileReader', () => {
  it('reads a row and refuses rows past the end of the file', () => {
    const reader = new VectorFileReader(DIMS);
    expect(reader.read(SOURCES_BIN, 0)).toEqual(E1);
    expect(reader.read(SOURCES_BIN, 1)).toEqual(E3);
    expect(reader.read(SOURCES_BIN, 2)).toBeUndefined();
    expect(reader.read(SOURCES_BIN, -1)).toBeUndefined();
    expect(reader.read(path.join(SMART_ENV, 'nope'), 0)).toBeUndefined();
  });
});

describe('Vault.maybeReload (binary layout)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scmcp-bin-'));
    fs.cpSync(FIXTURE, tmp, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('picks up new source entries and respects the throttle', () => {
    const v = Vault.load(tmp, 'vault-binary');
    const ajson = path.join(tmp, '.smart-env', 'smart_sources', 'smart_sources.ajson');
    fs.appendFileSync(
      ajson,
      '\n"smart_sources:New.md": {"path":"New.md","class_name":"SmartSource","embedding":{"default":{"testbin":{"file":"testbin","file_i":1}}},"blocks_data":{}},',
    );

    v.maybeReload(T0);
    expect(v.stats().notes).toBe(5);
    expect(v.stats().indexed).toBe(5);

    fs.appendFileSync(ajson, '\n"smart_sources:Other.md": {"path":"Other.md","class_name":"SmartSource","blocks_data":{}},');
    v.maybeReload(T0 + 500); // throttled
    expect(v.stats().notes).toBe(5);
    v.maybeReload(T0 + 5_000);
    expect(v.stats().notes).toBe(6);
  });

  it('re-reads the binary files when their contents change', () => {
    // A row reference beyond EOF is skipped until the binary file grows to cover it.
    fs.appendFileSync(
      path.join(tmp, '.smart-env', 'smart_sources', 'smart_sources.ajson'),
      '\n"smart_sources:Future.md": {"path":"Future.md","class_name":"SmartSource","embedding":{"default":{"testbin":{"file":"testbin","file_i":5}}},"blocks_data":{}},',
    );
    const v = Vault.load(tmp, 'vault-binary');
    expect(v.stats().notes).toBe(5);
    expect(v.stats().indexed).toBe(4);

    const bin = path.join(tmp, '.smart-env', 'smart_sources', 'testbin');
    writeVectors(bin, [E1, E3, E3, E3, E3, E1]);

    v.maybeReload(T0);
    expect(v.stats().indexed).toBe(5);

    // The snapshot was refreshed, so an unchanged vault stays idle instead of re-reading.
    v.maybeReload(T0 + 5_000);
    expect(v.stats().indexed).toBe(5);
    expect(Vault.load(tmp, 'vault-binary').stats().indexed).toBe(5);
  });
});