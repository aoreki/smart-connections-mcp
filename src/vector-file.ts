/**
 * Reader for Smart Connections' binary vector files (`smart_sources/<file>`,
 * `smart_blocks/<file>` in the newer `.smart-env` layout).
 *
 * Layout: a flat array of little-endian float32 vectors, `dims` wide, no header.
 * Row `file_i` therefore starts at byte `file_i * dims * 4`. Vectors are already
 * L2-normalized on disk, but VectorIndex normalizes again on insert.
 */

import * as fs from 'node:fs';

export class VectorFileReader {
  private cache = new Map<string, Buffer>();

  constructor(
    private readonly dims: number,
    private readonly warn: (msg: string) => void = () => {},
  ) {}

  /** The vector at `rowIndex` in `absPath`, or undefined if missing/out of range. */
  read(absPath: string, rowIndex: number): number[] | undefined {
    if (!Number.isInteger(rowIndex) || rowIndex < 0) return undefined;
    const buf = this.buffer(absPath);
    if (!buf) return undefined;

    const bytes = this.dims * 4;
    const offset = rowIndex * bytes;
    if (this.dims <= 0 || offset + bytes > buf.length) {
      this.warn(
        `${absPath}: row ${rowIndex} is out of bounds (file is ${buf.length} bytes, ` +
          `${this.dims}-dim vectors need ${bytes})`,
      );
      return undefined;
    }

    const out = new Array<number>(this.dims);
    for (let i = 0; i < this.dims; i++) out[i] = buf.readFloatLE(offset + i * 4);
    return out;
  }

  private buffer(absPath: string): Buffer | undefined {
    const cached = this.cache.get(absPath);
    if (cached) return cached;
    try {
      const buf = fs.readFileSync(absPath);
      this.cache.set(absPath, buf);
      return buf;
    } catch (e) {
      this.warn(`${absPath}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }
}