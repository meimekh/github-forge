// store.ts: the forge's whole state — users, repositories, refs, git objects, issues, labels, comments
// and pull requests — plus the REST-shaped serializers every surface reads. One process, one store,
// one place where a number or an id is minted. Everything is deterministic: timestamps come from a
// counter that starts at the scenario's fixed epoch, never from a clock.

import { hashObject, isOid, ZERO_OID, isoFromSec, type GitObject, type ObjectType } from './util.ts';
import {
  buildCommit,
  buildTreeEntries,
  compareTreeNames,
  parseCommit,
  parseTag,
  parseTree,
  type TreeEntry,
} from './objects.ts';

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Issue {
  readonly number: number;
  readonly id: number;
  /** The database id of the repository the issue belongs to. */
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  readonly seq: number;
  readonly user: string;
  closedAt: string | null;
  /** A cached serialization, dropped whenever the issue changes. */
  cache: string | null;
}

export interface Comment {
  readonly id: number;
  readonly repoId: number;
  readonly issue: number;
  readonly body: string;
  readonly seq: number;
  readonly user: string;
}

export interface Pull {
  readonly number: number;
  readonly id: number;
  readonly repoId: number;
  title: string;
  body: string;
  readonly head: string;
  readonly base: string;
  readonly headSha: string;
  readonly baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly seq: number;
  readonly user: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Issue[];
  readonly labels: Map<string, Label>;
  readonly comments: Comment[];
  readonly pulls: Pull[];
  nextIssue: number;
  nextLabel: number;
  nextComment: number;
  nextPull: number;
  /** Built fetch packs, keyed by the wants/haves/depth request that produced them. */
  readonly packCache: Map<string, Buffer>;
}

/** One flattened path in a tree. */
export interface FlatEntry {
  readonly mode: string;
  readonly oid: string;
}

const SEQUENCE_BASE = 1_735_689_600;

function compareLines(a: readonly string[], b: readonly string[]): { additions: number; deletions: number } {
  const counts = new Map<string, number>();
  for (const line of b) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of a) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const value of counts.values()) deletions += value;
  return { additions, deletions };
}

function splitLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const lines = data.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The forge: every repository the token's login owns, and the git objects under them. */
export class Forge {
  readonly viewer: User;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private clock = SEQUENCE_BASE;
  private counter = 0;
  /** The lock name, kept here only so one place builds it. */
  readonly lockName = 'repo-create';

  constructor(viewer: User) {
    this.viewer = viewer;
  }

  /** The next deterministic second: monotonic, so creation order is also time order. */
  nowSec(): number {
    this.clock += 1;
    return this.clock;
  }

  nowIso(): string {
    return isoFromSec(this.nowSec());
  }

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  get(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  create(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    this.nextRepoId += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: this.nowSec(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      labels: new Map(),
      comments: [],
      pulls: [],
      nextIssue: 1,
      nextLabel: 1,
      nextComment: 1,
      nextPull: 1,
      packCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  remove(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The viewer's repositories, oldest first (a stable order for pagination). */
  owned(viewer: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === viewer) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // ------------------------------------------------------------ objects

  put(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  object(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  has(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  /** Every object reachable from `roots`, following commits, trees and tags. */
  closure(repo: Repo, roots: Iterable<string>, skip?: (oid: string) => boolean): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isOid(root)) queue.push(root);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      if (skip !== undefined && skip(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (isOid(target)) queue.push(target);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
    return seen;
  }

  /** The commits reachable from `roots`, deepest generation first (newest first by stamp). */
  commitsFrom(repo: Repo, roots: Iterable<string>, limit = 10_000): { oid: string; stamp: number; message: string }[] {
    const seen = new Set<string>();
    const out: { oid: string; stamp: number; message: string }[] = [];
    const queue: string[] = [];
    for (const root of roots) if (isOid(root) && repo.objects.has(root)) queue.push(root);
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ oid, stamp: commitStamp(commit.committer), message: commit.message });
      for (const parent of commit.parents) queue.push(parent);
    }
    out.sort((a, b) => b.stamp - a.stamp || (a.oid < b.oid ? 1 : -1));
    return out;
  }

  /** Whether `ancestor` is reachable from `descendant`. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The best common ancestor of two commits (this repo's histories are linear). */
  mergeBase(repo: Repo, left: string, right: string): string | null {
    const ancestors = new Set<string>();
    const queue = [left];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const seen = new Set<string>();
    const walk = [right];
    while (walk.length > 0) {
      const oid = walk.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) walk.push(parent);
    }
    return null;
  }

  /** The tree an object id names: a commit's tree, a tree itself, or a tag's peeled target. */
  treeOf(repo: Repo, oid: string): string | null {
    const seen = new Set<string>();
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || seen.has(current)) return null;
      seen.add(current);
      if (object.type === 'tree') return current;
      if (object.type === 'commit') return parseCommit(object.data).tree;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  // ------------------------------------------------------------ trees

  /** Every file in a tree, keyed by its slash-joined path. */
  flatten(repo: Repo, treeOid: string): Map<string, FlatEntry> {
    const out = new Map<string, FlatEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the tree objects for a flat path map; answers the root tree id. */
  buildTree(repo: Repo, files: ReadonlyMap<string, FlatEntry>): string {
    interface Node {
      files: Map<string, FlatEntry>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      entries.sort(compareTreeNames);
      return this.put(repo, 'tree', buildTreeEntries(entries));
    };
    return build(root);
  }

  /** The commit a ref (or an object id) names, or null. */
  commitOf(repo: Repo, refOrOid: string): string | null {
    const direct = repo.refs.get(refOrOid) ?? repo.refs.get(`refs/heads/${refOrOid}`) ?? repo.refs.get(`refs/tags/${refOrOid}`);
    const oid = direct ?? refOrOid;
    const object = repo.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const peeled = repo.objects.get(target);
      return peeled !== undefined && peeled.type === 'commit' ? target : null;
    }
    return null;
  }

  /** The flat file map a ref names. */
  filesAt(repo: Repo, refOrOid: string): Map<string, FlatEntry> | null {
    const commit = this.commitOf(repo, refOrOid);
    if (commit === null) return null;
    const tree = this.treeOf(repo, commit);
    return tree === null ? null : this.flatten(repo, tree);
  }

  /** Store one commit and answer its id. */
  writeCommit(repo: Repo, tree: string, parents: readonly string[], message: string, stamp: number): string {
    const who = `${this.viewer.name} <${this.viewer.email}>`;
    return this.put(
      repo,
      'commit',
      buildCommit({ tree, parents, message: message.endsWith('\n') ? message : `${message}\n`, author: who, committer: who, timestamp: stamp }),
    );
  }

  // ------------------------------------------------------------ refs

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Every ref the repo holds, sorted by name. */
  listRefs(repo: Repo): { name: string; oid: string }[] {
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** The tip of HEAD, or null when the default branch is unborn. */
  headOid(repo: Repo): string | null {
    return repo.refs.get(this.headTarget(repo)) ?? null;
  }

  // ------------------------------------------------------------ issues and labels

  issue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((entry) => entry.number === number);
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const issue: Issue = {
      number,
      id: repo.id * 1_000_000 + number,
      repoId: repo.id,
      title: typeof title === 'string' ? title : '',
      body: typeof body === 'string' ? body : '',
      state: 'open',
      labelNames: [...labelNames],
      seq: this.nowSec(),
      user: this.viewer.login,
      closedAt: null,
      cache: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const label: Label = { id: repo.id * 1_000_000 + repo.nextLabel, name, color, description };
    repo.nextLabel += 1;
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  label(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name.toLowerCase());
  }

  addComment(repo: Repo, issue: number, body: string): Comment {
    const comment: Comment = { id: repo.id * 1_000_000 + repo.nextComment, repoId: repo.id, issue, body, seq: this.nowSec(), user: this.viewer.login };
    repo.nextComment += 1;
    repo.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  pull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((entry) => entry.number === number);
  }

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string; headSha: string; baseSha: string }): Pull {
    const number = repo.nextPull;
    repo.nextPull += 1;
    const pull: Pull = {
      number,
      id: repo.id * 1_000_000 + number,
      repoId: repo.id,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      headSha: input.headSha,
      baseSha: input.baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nowSec(),
      user: this.viewer.login,
    };
    repo.pulls.push(pull);
    return pull;
  }

  // ------------------------------------------------------------ contents and merges

  /** One file's bytes at a ref. */
  fileAt(repo: Repo, refOrOid: string, path: string): { oid: string; mode: string; data: Buffer } | null {
    const files = this.filesAt(repo, refOrOid);
    if (files === null) return null;
    const entry = files.get(path);
    if (entry === undefined) return null;
    const object = repo.objects.get(entry.oid);
    if (object === undefined) return null;
    return { oid: entry.oid, mode: entry.mode, data: object.data };
  }

  /** Write `path` (bytes `data`) into the tree at `refFrom`, commit it on `branch`, answer the new ids. */
  writeFile(
    repo: Repo,
    options: { branch: string; path: string; data: Buffer; message: string },
  ): { commit: string; blob: string } {
    const ref = `refs/heads/${options.branch}`;
    const tip = repo.refs.get(ref) ?? null;
    const files = tip === null ? new Map<string, FlatEntry>() : this.flatten(repo, this.treeOf(repo, tip)!);
    const blob = this.put(repo, 'blob', options.data);
    files.set(options.path, { mode: '100644', oid: blob });
    const tree = this.buildTree(repo, files);
    const commit = this.writeCommit(repo, tree, tip === null ? [] : [tip], options.message, this.nowSec());
    repo.refs.set(ref, commit);
    return { commit, blob };
  }

  /** Delete `path` from the branch, commit the removal, answer the new commit id. */
  deleteFile(repo: Repo, options: { branch: string; path: string; message: string }): string | null {
    const ref = `refs/heads/${options.branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const tree = this.treeOf(repo, tip);
    if (tree === null) return null;
    const files = this.flatten(repo, tree);
    if (!files.delete(options.path)) return null;
    const newTree = this.buildTree(repo, files);
    const commit = this.writeCommit(repo, newTree, [tip], options.message, this.nowSec());
    repo.refs.set(ref, commit);
    return commit;
  }

  /** The paths that differ between two flat file maps, with a line-stat each. */
  diff(repo: Repo, from: ReadonlyMap<string, FlatEntry> | null, to: ReadonlyMap<string, FlatEntry>): PullFile[] {
    const out: PullFile[] = [];
    const paths = new Set<string>();
    if (from !== null) for (const path of from.keys()) paths.add(path);
    for (const path of to.keys()) paths.add(path);
    for (const path of paths) {
      const left = from?.get(path);
      const right = to.get(path);
      if (left !== undefined && right !== undefined && left.oid === right.oid && left.mode === right.mode) continue;
      const leftData = left === undefined ? Buffer.alloc(0) : (repo.objects.get(left.oid)?.data ?? Buffer.alloc(0));
      const rightData = right === undefined ? Buffer.alloc(0) : (repo.objects.get(right.oid)?.data ?? Buffer.alloc(0));
      const status = left === undefined ? 'added' : right === undefined ? 'removed' : 'modified';
      const stat = status === 'removed' ? { additions: 0, deletions: splitLines(leftData).length } : compareLines(splitLines(rightData), splitLines(leftData));
      out.push({
        filename: path,
        status,
        additions: stat.additions,
        deletions: stat.deletions,
        changes: stat.additions + stat.deletions,
        patch: '',
      });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  /**
   * Squash-merge a pull request: three-way merge head into base, refuse a conflict, then place one
   * commit on the base branch. Answers the new commit id, or why it was refused.
   */
  mergePull(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'merged' | 'missing' } {
    if (pull.merged) return { ok: false, reason: 'merged' };
    const baseRef = `refs/heads/${pull.base}`;
    const baseTip = repo.refs.get(baseRef);
    if (baseTip === undefined) return { ok: false, reason: 'missing' };
    if (!repo.objects.has(pull.headSha)) return { ok: false, reason: 'missing' };
    const mergeBaseOid = this.mergeBase(repo, baseTip, pull.headSha);
    if (mergeBaseOid === null) {
      // Unrelated histories: refuse rather than invent a merge.
      return { ok: false, reason: 'conflict' };
    }
    const baseFiles = this.flatten(repo, this.treeOf(repo, baseTip)!);
    const headFiles = this.flatten(repo, this.treeOf(repo, pull.headSha)!);
    const mergeFiles = this.flatten(repo, this.treeOf(repo, mergeBaseOid)!);
    const paths = new Set<string>();
    for (const path of baseFiles.keys()) paths.add(path);
    for (const path of headFiles.keys()) paths.add(path);
    for (const path of mergeFiles.keys()) paths.add(path);
    const into = new Map<string, FlatEntry>(baseFiles);
    for (const path of paths) {
      const ancestor = mergeFiles.get(path);
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      const baseChanged = !sameEntry(base, ancestor);
      const headChanged = !sameEntry(head, ancestor);
      if (!headChanged) continue;
      if (!baseChanged) {
        if (head === undefined) into.delete(path);
        else into.set(path, head);
        continue;
      }
      if (sameEntry(base, head)) continue;
      return { ok: false, reason: 'conflict' };
    }
    const tree = this.buildTree(repo, into);
    const sha = this.writeCommit(repo, tree, [baseTip], `Merge pull request #${pull.number} from ${pull.head}\n`, this.nowSec());
    repo.refs.set(baseRef, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    return { ok: true, sha };
  }
}

export interface PullFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch: string;
}

function sameEntry(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

/** The committer stamp out of a commit's `committer ... <time> <tz>` line. */
function commitStamp(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match === null ? 0 : Number(match[1]);
}

export { ZERO_OID };
