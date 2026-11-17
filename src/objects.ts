// objects.ts: the git object model — tree/commit/tag parsing and building, packfile reading (plain,
// OFS_DELTA and REF_DELTA entries) and packfile writing. Everything is computed here; nothing shells
// out and nothing but node:zlib/node:crypto is used.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, isOid, type GitObject, type ObjectType } from './util.ts';

/** One parsed tree entry. `mode` is git's ASCII mode, e.g. `100644`, `40000`, `120000`, `160000`. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: ObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** git's tree-entry order: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.toString('ascii', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTreeEntries(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const header = data.toString('utf8', 0, headerEnd);
  const message = blank < 0 ? '' : data.toString('utf8', blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let start = 0;
  while (start < header.length) {
    let end = header.indexOf('\n', start);
    if (end < 0) end = header.length;
    const line = header.slice(start, end);
    start = end + 1;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/** The fields a generated commit carries; every one is caller-supplied (never a wall clock). */
export interface CommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
  /** Unix seconds. */
  readonly timestamp: number;
  readonly timezone?: string;
}

/** Build a commit object's bytes. */
export function buildCommit(fields: CommitFields): Buffer {
  const timezone = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(
    `author ${fields.author} ${fields.timestamp} ${timezone}`,
    `committer ${fields.committer} ${fields.timestamp} ${timezone}`,
    '',
  );
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.toString('utf8', 0, headerEnd).split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: (type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit') as ObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.toString('utf8', blank + 2),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: ObjectType;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const timezone = fields.timezone ?? '+0000';
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} ${timezone}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- packs

const TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Parse a pack header: version and declared object count, plus where the entries start. */
export function readPackHeader(pack: Buffer): { version: number; count: number; start: number } {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  return { version: pack.readUInt32BE(4), count: pack.readUInt32BE(8), start: 12 };
}

/** Inflate one zlib stream at `offset`; answers the bytes and the offset just past the stream. */
export function inflateAt(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const view = pack.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
  oid: string;
  type: ObjectType;
  data_: Buffer;
}

/**
 * Read a whole packfile: inflate every entry, resolve OFS_DELTA and REF_DELTA recursively and answer
 * the objects keyed by their recomputed id. `resolveBase` supplies a thin pack's absent bases.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): { objects: Map<string, GitObject>; deltaCount: number; count: number } {
  const { count, start } = readPackHeader(pack);
  const trailerStart = pack.length - 20;
  const objects = new Map<string, GitObject>();
  const entries: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack is truncated');
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawPackEntry = {
      offset: entryOffset,
      typeCode,
      size,
      data: Buffer.alloc(0),
      baseOffset: -1,
      baseOid: '',
      oid: '',
      type: 'blob',
      data_: Buffer.alloc(0),
    };
    if (typeCode === 6) {
      let byte2 = pack[offset++]!;
      let value = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[offset++]!;
        value = (value + 1) * 128 + (byte2 & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
      byOffset.set(entry.baseOffset, undefined as unknown as RawPackEntry);
    } else if (typeCode === 7) {
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    entry.size = inflated.data.length;
    offset = inflated.next;
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<string, RawPackEntry>();
  const resolve = (entry: RawPackEntry): RawPackEntry => {
    if (entry.oid !== '') return entry;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset);
      if (base === undefined) throw new Error(`ofs-delta base at ${entry.baseOffset} is not in the pack`);
      const parent = resolve(base);
      entry.type = parent.type;
      entry.data_ = applyDelta(parent.data_, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = resolved.get(entry.baseOid);
      if (inPack !== undefined) {
        const parent = resolve(inPack);
        entry.type = parent.type;
        entry.data_ = applyDelta(parent.data_, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid);
        if (external === undefined) throw new Error(`ref-delta base ${entry.baseOid} is neither in the pack nor supplied`);
        entry.type = external.type;
        entry.data_ = applyDelta(external.data, entry.data);
      }
    } else {
      entry.type = CODE_TYPE[entry.typeCode]!;
      entry.data_ = entry.data;
    }
    entry.oid = hashObject(entry.type, entry.data_);
    resolved.set(entry.oid, entry);
    return entry;
  };
  let deltaCount = 0;
  for (const entry of entries) {
    const done = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(done.oid)) objects.set(done.oid, { type: done.type, data: done.data_ });
  }
  return { objects, deltaCount, count };
}

/** One object to place in a pack. */
export interface PackInput {
  readonly oid: string;
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** Build a packfile (version 2, plain objects, no deltas) with its SHA-1 trailer. */
export function writePack(objects: readonly PackInput[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const code = TYPE_CODE[object.type];
    const bytes: number[] = [];
    let remaining = object.data.length;
    let first = (code << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes), deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
