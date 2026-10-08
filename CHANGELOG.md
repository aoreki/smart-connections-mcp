# Changelog

## Unreleased

### Fixed
- **Newer Smart Connections layouts load again.** Recent plugin versions dropped
  `.smart-env/multi/` entirely: vectors moved into binary float32 files
  (`smart_sources/<file>`, `smart_blocks/<file>`) that entries reference by row
  index, note metadata moved to `smart_sources/smart_sources.ajson`, block
  metadata into each source's `blocks_data`, and the model key/width into
  `embedding_models/embedding_models.ajson`. Such a vault used to fail with
  `Missing …/.smart-env/multi — no embeddings generated yet?` and, when it was the
  only vault, `Error: no vaults loaded successfully.`. The layout is now detected
  automatically; the older `multi/` layout keeps working unchanged. Block
  `include_blocks` keys follow the new convention (single `#`, e.g. `#Intro`).
- Freshness checks now watch the files that actually exist in each layout, so
  edits (including appended binary rows) are still picked up without a restart.
- A malformed or half-written `.smart-env` no longer aborts a tool call; the
  vault reloads on the next check.

## 2.0.1 — 2026-08-21

### Fixed
- **Non-English text no longer crashes the embedder** (#10). Inputs were cut to
  1,500 characters, but `TaylorAI/bge-micro-v2` ships a placeholder
  `model_max_length`, so 1,500 chars of German (~560 tokens) overflowed its 512
  position embeddings, onnxruntime threw, and `search_notes` silently dropped to
  `keyword-fallback`. The tokenizer is now capped at the model's real
  `max_position_embeddings`, so truncation happens at the token level for any
  language — including the parity check, which embeds a full stored note.
- **Stale `model_key` in `smart_env.json` no longer empties the index** (#9).
  Switching models in Smart Connections can re-embed every `.ajson` under the
  new key while the config keeps the old one; every vector lookup then missed
  and search returned `[]` in `"mode": "semantic"`. The server now trusts the
  data when the declared model has no vectors, logs the override, and reports
  the config value as `declaredModelKey` in `get_stats` / `list_vaults`.
- A vault with **no vectors indexed** now falls back to keyword matching with an
  explicit warning instead of returning an empty semantic result.

## 2.0.0 — 2026-07-13

### Added
- **True semantic search**: `search_notes` now embeds your query locally with the
  same model your vault's Smart Connections index used (via transformers.js).
  Conceptual queries work; nothing leaves your machine.
- **Multi-vault**: `SMART_VAULT_PATH` accepts comma-separated paths; tools take an
  optional `vault` parameter; new `list_vaults` tool.
- **Block-level retrieval**: search matches individual sections (blocks) and
  returns content snippets inline.
- **Freshness**: `.smart-env` changes are picked up automatically (throttled
  incremental reload) — no server restart after editing notes.
- `get_note_content` `include_blocks` now actually extracts the named blocks.
- Explicit `mode: "keyword-fallback"` + warning when the embedding model cannot
  load, instead of silently degraded results.

### Fixed
- Path traversal in `get_note_content` (reads outside the vault are rejected).
- Crash on regex metacharacters in search queries.
- `.ajson` deletion entries (`null`) are now honored.

### Removed (breaking)
- `get_embedding_neighbors` tool.
- `search_notes` response shape changed (adds `vault`, `scope`, `block`,
  `snippet`, `mode`).

### Changed
- Requires Node >= 20. MCP SDK updated to the current 1.x line.
- First run downloads the embedding model (~25MB, cached locally forever).
