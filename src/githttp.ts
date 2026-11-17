// githttp.ts: git smart HTTP — the v0 and protocol-v2 advertisements, ls-refs, fetch (with shallow
// support and side-band framing) and receive-pack (pack parsing, fast-forward checks and a
// report-status stream). Everything runs in process: no git binary, no client library.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge, Repo } from './store.ts';
import { parseCommit, parseTag, parseTree, readPack, writePack, type PackInput } from './objects.ts';
import {
  ZERO_OID,
  isOid,
  pktLine,
  PKT_DELIM,
  PKT_FLUSH,
  parsePackets,
  sendRaw,
  type Packet,
} from './util.ts';

const AGENT = 'makefun-forge/1.0';
const SIDEBAND_CHUNK = 65500;

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The capabilities the v0 upload-pack advertisement carries. */
function uploadCapabilities(symrefTarget: string): string {
  return `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress agent=${AGENT} symref=HEAD:${symrefTarget}`;
}

/** The capabilities the receive-pack advertisement carries (v0 only). */
function receiveCapabilities(): string {
  return `report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet agent=${AGENT}`;
}

/** One `<oid> <name>` line, peeled tags marked. */
function refLines(forge: Forge, repo: Repo): string[] {
  const lines: string[] = [];
  for (const ref of forge.listRefs(repo)) {
    lines.push(`${ref.oid} ${ref.name}`);
    const object = repo.objects.get(ref.oid);
    if (ref.name.startsWith('refs/tags/') && object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isOid(target)) lines.push(`${target} ${ref.name}^{}`);
    }
  }
  return lines;
}

/** GET /<owner>/<repo>.git/info/refs?service=... */
export function handleInfoRefs(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  service: string,
  query: Map<string, string>,
): void {
  if (query.get('service') !== service) {
    sendRaw(res, 400, 'dumb protocol is not supported', 'text/plain; charset=utf-8');
    return;
  }
  const v0 = service === 'git-receive-pack';
  const capabilities = v0 ? receiveCapabilities() : uploadCapabilities(forge.headTarget(repo));
  const wanted = typeof req.headers['git-protocol'] === 'string' && (req.headers['git-protocol'] as string).includes('version=2');
  const contentType = v0 ? RECEIVE_ADVERTISEMENT : UPLOAD_ADVERTISEMENT;
  const head = forge.headOid(repo);
  if (!v0 && wanted) {
    const parts: Buffer[] = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    sendRaw(res, 200, Buffer.concat(parts), contentType, { 'cache-control': 'no-cache' });
    return;
  }
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = refLines(forge, repo);
  if (head !== null) parts.push(pktLine(`${head} HEAD\u0000${capabilities}\n`));
  else if (refs.length > 0) parts.push(pktLine(`${ZERO_OID} HEAD\u0000${capabilities}\n`));
  else parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  for (const line of refs) parts.push(pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), contentType, { 'cache-control': 'no-cache' });
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
  thinPack: boolean;
  haveCut: Set<string>;
}

function argsOf(packets: readonly Packet[]): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim' || packet.kind === 'flush') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs && line.startsWith('command=')) {
      command = line.slice(8);
      continue;
    }
    if (line === '') continue;
    args.push(line);
  }
  return { command, args };
}

/** The commits within `depth` generations of `wants`, plus the boundary the cut leaves behind. */
function shallowWalk(repo: Repo, wants: readonly string[], depth: number): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  let frontier = wants.filter((oid) => isOid(oid));
  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (commits.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      commits.add(oid);
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (isOid(target)) next.push(target);
        continue;
      }
      if (object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (level < depth) {
        for (const parent of commit.parents) next.push(parent);
      } else if (commit.parents.length > 0) {
        boundary.add(oid);
      }
    }
    frontier = next;
  }
  return { commits, boundary };
}

/** Every object reachable from `roots`, with the parents of `cut` commits left unwalked. */
function closureCut(repo: Repo, roots: Iterable<string>, cut: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!cut.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isOid(target)) queue.push(target);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return seen;
}

/** The pack a fetch answers with, memoized per request shape (the clone workload repeats it). */
function fetchPack(forge: Forge, repo: Repo, request: FetchRequest, cutSet: ReadonlySet<string>): Buffer {
  const key = `${repo.id}|${request.depth ?? ''}|${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}`;
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  // What the client already holds: everything reachable from its haves, with its declared shallow
  // boundaries treated as roots (their parents are not held).
  const held = closureCut(repo, request.haves, cutSet);
  let selected: Set<string>;
  if (request.depth !== undefined && request.depth > 0) {
    // A shallow fetch: the commits within `depth` generations and their trees, parents left out.
    const walk = shallowWalk(repo, request.wants, request.depth);
    selected = closureCut(repo, walk.commits, walk.commits);
    for (const oid of request.wants) if (repo.objects.has(oid)) selected.add(oid);
  } else {
    selected = closureCut(repo, request.wants, new Set<string>());
  }
  const wanted = new Set<string>();
  for (const oid of selected) if (!held.has(oid)) wanted.add(oid);
  const oids = [...wanted].sort();
  const inputs: PackInput[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) inputs.push({ oid, type: object.type, data: object.data });
  }
  const pack = writePack(inputs);
  if (repo.packCache.size > 48) repo.packCache.clear();
  repo.packCache.set(key, pack);
  return pack;
}

/** The sideband packets for one pack. */
function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, pack.length));
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = 1;
    chunk.copy(payload, 1);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

/** POST /<owner>/<repo>.git/git-upload-pack */
export function handleUploadPack(forge: Forge, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets } = parsePackets(body);
  const { command, args } = argsOf(packets);
  if (command === 'ls-refs') {
    sendRaw(res, 200, lsRefsResult(forge, repo, args), UPLOAD_RESULT, { 'cache-control': 'no-cache' });
    return;
  }
  if (command !== 'fetch') {
    sendRaw(res, 400, 'the upload-pack request has no command', 'text/plain; charset=utf-8');
    return;
  }
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, done: false, thinPack: false, haveCut: new Set() };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
    else if (arg === 'thin-pack') request.thinPack = true;
    else if (arg === 'done') request.done = true;
  }
  const walk = request.depth !== undefined && request.depth > 0 ? shallowWalk(repo, request.wants, request.depth) : null;
  const cutSet = new Set<string>(request.shallow);
  const sections: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n')];
  if (walk !== null) {
    sections.push(PKT_DELIM, pktLine('shallow-info\n'));
    for (const oid of walk.boundary) if (!request.shallow.includes(oid)) sections.push(pktLine(`shallow ${oid}\n`));
    for (const oid of request.shallow) if (!walk.boundary.has(oid)) sections.push(pktLine(`unshallow ${oid}\n`));
  }
  const pack = fetchPack(forge, repo, request, cutSet);
  sections.push(PKT_DELIM, pktLine('packfile\n'), sideband(pack), PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(sections), UPLOAD_RESULT, { 'cache-control': 'no-cache' });
}

/** The v2 ls-refs answer, honouring peel, symrefs and ref-prefix. */
function lsRefsResult(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11).trim());
  }
  const matches = (name: string): boolean => {
    if (prefixes.length === 0) return true;
    for (const prefix of prefixes) if (name.startsWith(prefix)) return true;
    return false;
  };
  const parts: Buffer[] = [];
  const head = forge.headOid(repo);
  const headTarget = forge.headTarget(repo);
  if (matches('HEAD')) {
    const symref = symrefs ? ` symref-target:${headTarget}` : '';
    if (head === null) parts.push(pktLine(`unborn HEAD${symref}\n`));
    else parts.push(pktLine(`${head} HEAD${symref}\n`));
  }
  for (const ref of forge.listRefs(repo)) {
    if (!matches(ref.name)) continue;
    let extra = '';
    if (peel && ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (isOid(target)) extra = ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${ref.oid} ${ref.name}${extra}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Demultiplex the sideband-framed report into pkt-line bytes. */
function reportStream(lines: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /<owner>/<repo>.git/git-receive-pack */
export function handleReceivePack(forge: Forge, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets, rest } = parsePackets(body);
  const commands: PushCommand[] = [];
  let sidebandWanted = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.includes('side-band-64k')) sidebandWanted = true;
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    if (line === '') continue;
    const firstSpace = line.indexOf(' ');
    const secondSpace = line.indexOf(' ', firstSpace + 1);
    if (firstSpace < 0 || secondSpace < 0) continue;
    commands.push({
      oldOid: line.slice(0, firstSpace),
      newOid: line.slice(firstSpace + 1, secondSpace),
      ref: line.slice(secondSpace + 1),
    });
  }
  if (rest.length >= 12 && rest.toString('ascii', 0, 4) === 'PACK') {
    const read = readPack(rest, (oid) => repo.objects.get(oid));
    for (const [oid, object] of read.objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }
  const lines: string[] = [];
  let unpackOk = true;
  for (const command of commands) {
    if (!command.ref.startsWith('refs/') || !isOid(command.oldOid) || !isOid(command.newOid)) {
      lines.push(`ng ${command.ref || 'unknown'} invalid command`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    const existing = current ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      if (current === undefined || existing !== command.oldOid) lines.push(`ng ${command.ref} non-fast-forward`);
      else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      lines.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (existing !== command.oldOid) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (existing !== ZERO_OID) {
      const object = repo.objects.get(command.newOid);
      const isCommit = object !== undefined && (object.type === 'commit' || object.type === 'tag');
      if (isCommit && !forge.isAncestor(repo, existing, command.newOid)) {
        lines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  const inner = reportStream([unpackOk ? 'unpack ok' : 'unpack failed', ...lines]);
  if (sidebandWanted) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < inner.length; offset += SIDEBAND_CHUNK) {
      const chunk = inner.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, inner.length));
      const payload = Buffer.allocUnsafe(chunk.length + 1);
      payload[0] = 1;
      chunk.copy(payload, 1);
      parts.push(pktLine(payload));
    }
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), RECEIVE_RESULT, { 'cache-control': 'no-cache' });
    return;
  }
  sendRaw(res, 200, inner, RECEIVE_RESULT, { 'cache-control': 'no-cache' });
}


