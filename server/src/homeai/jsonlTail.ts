import * as fs from 'node:fs';

const MAX_CHUNK = 1 << 20;

export class JsonlTail {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);

  constructor(readonly file: string) {}
  get readOffset(): number {
    return this.offset;
  }

  /** Complete new lines since the last call; `null` once the file no longer exists. */
  read(): string[] | null {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.pending = Buffer.alloc(0);
    }
    const lines: string[] = [];
    if (size === this.offset) return lines;
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file, 'r');
      while (this.offset < size) {
        const len = Math.min(size - this.offset, MAX_CHUNK);
        const chunk = Buffer.alloc(len);
        const n = fs.readSync(fd, chunk, 0, len, this.offset);
        if (n <= 0) break;
        this.offset += n;
        const data = this.pending.length
          ? Buffer.concat([this.pending, chunk.subarray(0, n)])
          : chunk.subarray(0, n);
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          this.pending = Buffer.from(data);
          continue;
        }
        this.pending = Buffer.from(data.subarray(lastNewline + 1));
        for (const raw of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
          const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          if (text.trim()) lines.push(text);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return lines;
  }
}
