// util.ts: the wire primitives every other module builds on — SHA-1 git object hashing, zlib loose
// objects, pkt-line framing, percent-decoding and the two HTTP reply helpers. Node built-ins only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Every JSON reply's content type. */
export const JSON_TYPE = 'application/json; charset=utf-8';
/** git's all-zero object id. */
export const ZERO_OID = '0'.repeat(40);
/** The biggest pkt-line payload (git's LARGE_PACKET_MAX is 65520 with its 4-byte header). */
export const PKT_MAX_PAYLOAD = 65516;
/** git's LARGE_PACKET_MAX: the largest framed packet, header included. */
export const PKT_MAX_FRAME = 65520;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One object as the store keeps it: its type and its exact content bytes. */
export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX4_RE = /^[0-9a-f]{4}$/;

/** True for a 40-character lowercase hex object id. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && HEX40_RE.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` plus the object's bytes. */
export function objectHeader(type: ObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

export function hashObject(type: ObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return createHash('sha1').update(objectHeader(type, body.length)).update(body).digest('hex');
}

/** A loose object's bytes as git writes them to disk: zlib over header + content. */
export function encodeLooseObject(type: ObjectType, data: Uint8Array): Buffer {
  return deflateSync(Buffer.concat([objectHeader(type, data.length), data]));
}

/** Read a loose object back: inflate, then split `<type> <size>\0` from the content. */
export function decodeLooseObject(bytes: Uint8Array): GitObject {
  const raw = inflateSync(bytes);
  const nul = raw.indexOf(0x00);
  if (nul < 0) throw new Error('loose object has no header terminator');
  const header = raw.subarray(0, nul).toString('ascii');
  const space = header.indexOf(' ');
  const type = header.slice(0, space) as ObjectType;
  const size = Number(header.slice(space + 1));
  const data = raw.subarray(nul + 1);
  if (size !== data.length) throw new Error(`loose object declares ${size} bytes, holds ${data.length}`);
  return { type, data };
}

// ---------------------------------------------------------------- pkt-line

/** One framed packet. `bad` marks a short or non-hex header: the caller keeps the rest as raw bytes. */
export interface Packet {
  readonly kind: 'data' | 'flush' | 'delim' | 'end';
  readonly payload: Buffer;
}

export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_MAX_PAYLOAD) throw new Error(`pkt-line payload ${data.length} is over ${PKT_MAX_PAYLOAD}`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Frame a mixed sequence of payloads and the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode the pkt-line stream at the front of `buffer`. Stops at the first short or non-hex header and
 * answers the untouched tail in `rest` (receive-pack puts a raw packfile right after a flush).
 */
export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.toString('ascii', offset, offset + 4);
    if (!HEX4_RE.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** The UTF-8 text of every data packet, its trailing newline kept. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------- text

/** Percent-decode one path segment; a malformed escape is left as it came. */
export function decodeSegment(segment: string): string {
  if (segment.indexOf('%') < 0 && segment.indexOf('+') < 0) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a request target's path into its decoded, non-empty segments. */
export function splitPath(path: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index === path.length || path.charCodeAt(index) === 47) {
      if (index > start) segments.push(decodeSegment(path.slice(start, index)));
      start = index + 1;
    }
  }
  return segments;
}

/** Parse a query string into a map (the last value of a repeated key wins). */
export function parseQuery(search: string): Map<string, string> {
  const query = new Map<string, string>();
  if (search.length === 0) return query;
  for (const part of search.split('&')) {
    if (part.length === 0) continue;
    const equals = part.indexOf('=');
    const key = decodeSegment(equals < 0 ? part : part.slice(0, equals));
    if (key.length === 0) continue;
    query.set(key, equals < 0 ? '' : decodeSegment(part.slice(equals + 1)));
  }
  return query;
}

/** A fixed-width ISO-8601 stamp for a deterministic epoch second (never a wall clock). */
export function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------- HTTP

/** Write a JSON body with a content-length and the caller's extra headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const text = JSON.stringify(body);
  sendRaw(res, status, text, JSON_TYPE, headers);
}

/** Write a body with an explicit content type. */
export function sendRaw(
  res: ServerResponse,
  status: number,
  body: string | Uint8Array,
  contentType?: string,
  headers?: Record<string, string>,
): void {
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  const head: Record<string, string | number> = { 'content-length': length };
  if (contentType !== undefined) head['content-type'] = contentType;
  if (headers !== undefined) for (const key of Object.keys(headers)) head[key] = headers[key];
  try {
    res.writeHead(status, head);
    res.end(body);
  } catch {
    // the peer went away between the request and the answer
  }
}

/** Write a bodyless reply (204 and friends). */
export function sendEmpty(res: ServerResponse, status: number, headers?: Record<string, string>): void {
  const head: Record<string, string | number> = { 'content-length': 0 };
  if (headers !== undefined) for (const key of Object.keys(headers)) head[key] = headers[key];
  try {
    res.writeHead(status, head);
    res.end();
  } catch {
    // the peer went away
  }
}

/** Read a whole request body, capped. */
export async function readBody(req: IncomingMessage, max = 96 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > max) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
}

/** A stable, non-empty request id: no clock, no randomness, just a per-process counter. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `MF-${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** A short one-line description of a thrown value. */
export function messageOf(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/\s+/g, ' ').trim();
}
