// graphql.ts: a small GraphQL v4 executor for the documents gh and github-mcp-server send — a
// hand-written parser (aliases, arguments, variables, inline fragments, enums, batching) and a
// resolver over the forge's store, plus the introspection the feature probes read. An unknown field
// is a 200 with an errors array; an unknown repository is data.repository = null with no errors.

import type { ServerResponse } from 'node:http';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { reply as restReply } from './rest.ts';

interface ValueNode {
  readonly kind: 'var' | 'int' | 'float' | 'string' | 'bool' | 'null' | 'enum' | 'list' | 'object';
  readonly value: unknown;
  readonly items?: ValueNode[];
  readonly fields?: { readonly key: string; readonly value: ValueNode }[];
}

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string;
  readonly name: string;
  readonly args: Readonly<Record<string, ValueNode>>;
  readonly selections: Selection[];
}

interface Selection {
  kind: 'field' | 'spread' | 'inline';
  alias?: string;
  name?: string;
  args?: Readonly<Record<string, ValueNode>>;
  selections?: Selection[];
  typeCondition?: string;
}

interface Document {
  readonly operations: { readonly type: string; readonly selections: Selection[] }[];
  readonly fragments: ReadonlyMap<string, readonly Selection[]>;
}

const IDENT_START = /[_A-Za-z]/;
const IDENT_PART = /[_0-9A-Za-z]/;

/** A cursor is the opaque string a connection hands back; this one carries the offset it resumes at. */
function cursorOf(offset: number): string {
  return `cursor:${offset}`;
}

function offsetOf(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  const parsed = Number.parseInt(cursor.replace(/^cursor:/, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// ---------------------------------------------------------------- the parser

class Reader {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      const char = this.text[this.pos];
      if (char === undefined) return;
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '\u0000' || char === '\ufeff') {
        this.pos += 1;
        continue;
      }
      if (char === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  atEnd(): boolean {
    this.skipIgnored();
    return this.pos >= this.text.length;
  }

  consume(token: string): boolean {
    this.skipIgnored();
    if (this.text.startsWith(token, this.pos)) {
      this.pos += token.length;
      return true;
    }
    return false;
  }

  expect(token: string): void {
    if (!this.consume(token)) throw new Error(`expected ${JSON.stringify(token)} at ${this.pos}`);
  }

  identifier(): string {
    this.skipIgnored();
    const char = this.text[this.pos] ?? '';
    if (!IDENT_START.test(char)) throw new Error(`expected an identifier at ${this.pos}`);
    let index = this.pos;
    while (index < this.text.length && IDENT_PART.test(this.text[index]!)) index += 1;
    const name = this.text.slice(this.pos, index);
    this.pos = index;
    return name;
  }

  /** Skip an operation name and its variable definitions (they never change the answer here). */
  skipOperationHeader(): void {
    this.skipIgnored();
    if (IDENT_START.test(this.text[this.pos] ?? '')) this.identifier();
    this.skipIgnored();
    if (this.text[this.pos] !== '(') return;
    let depth = 0;
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]!;
      this.pos += 1;
      if (char === '"') {
        while (this.pos < this.text.length && this.text[this.pos] !== '"') {
          if (this.text[this.pos] === '\\') this.pos += 1;
          this.pos += 1;
        }
        this.pos += 1;
      } else if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private string(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]!;
      this.pos += 1;
      if (char === '"') return out;
      if (char === '\\') {
        const next = this.text[this.pos] ?? '';
        this.pos += 1;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === 'b') out += '\b';
        else if (next === 'f') out += '\f';
        else if (next === 'u') {
          out += String.fromCharCode(Number.parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += next;
        continue;
      }
      out += char;
    }
    throw new Error('an unterminated string');
  }

  value(): ValueNode {
    this.skipIgnored();
    const char = this.text[this.pos] ?? '';
    if (char === '$') {
      this.pos += 1;
      return { kind: 'var', value: this.identifier() };
    }
    if (char === '"') return { kind: 'string', value: this.string() };
    if (char === '[') {
      this.pos += 1;
      const items: ValueNode[] = [];
      for (;;) {
        this.skipIgnored();
        if (this.consume(']')) break;
        items.push(this.value());
      }
      return { kind: 'list', value: items, items };
    }
    if (char === '{') {
      this.pos += 1;
      const fields: { key: string; value: ValueNode }[] = [];
      for (;;) {
        this.skipIgnored();
        if (this.consume('}')) break;
        const key = this.identifier();
        this.expect(':');
        fields.push({ key, value: this.value() });
      }
      return { kind: 'object', value: fields, fields };
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      let index = this.pos;
      if (this.text[index] === '-') index += 1;
      while (index < this.text.length && this.text[index]! >= '0' && this.text[index]! <= '9') index += 1;
      let float = false;
      if (this.text[index] === '.' || this.text[index] === 'e' || this.text[index] === 'E') {
        float = true;
        index += 1;
        while (index < this.text.length && /[0-9+.-]/.test(this.text[index]!)) index += 1;
      }
      const parsed = Number(this.text.slice(this.pos, index));
      this.pos = index;
      return { kind: float ? 'float' : 'int', value: Number.isFinite(parsed) ? parsed : 0 };
    }
    if (char === 't' || char === 'f' || char === 'n') {
      const word = this.identifier();
      if (word === 'null') return { kind: 'null', value: null };
      return { kind: 'bool', value: word === 'true' };
    }
    return { kind: 'enum', value: this.identifier() };
  }

  selections(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.consume('}')) break;
      if (this.consume('...')) {
        if (this.consume('on')) {
          const typeCondition = this.identifier();
          out.push({ kind: 'inline', typeCondition, selections: this.selections() });
          continue;
        }
        out.push({ kind: 'spread', name: this.identifier() });
        continue;
      }
      const first = this.identifier();
      let alias = first;
      let name = first;
      if (this.consume(':')) name = this.identifier();
      const args: Record<string, ValueNode> = {};
      if (this.consume('(')) {
        for (;;) {
          this.skipIgnored();
          if (this.consume(')')) break;
          const key = this.identifier();
          this.expect(':');
          args[key] = this.value();
        }
      }
      this.skipIgnored();
      const selections = this.text[this.pos] === '{' ? this.selections() : [];
      out.push({ kind: 'field', alias, name, args, selections });
    }
    return out;
  }
}

/** Parse a GraphQL document; a syntax error throws (the caller turns it into an errors array). */
export function parseDocument(text: string): Document {
  const reader = new Reader(text);
  const operations: Document['operations'] = [];
  const fragments = new Map<string, readonly Selection[]>();
  while (!reader.atEnd()) {
    if (reader.consume('fragment')) {
      const name = reader.identifier();
      reader.consume('on');
      reader.identifier();
      fragments.set(name, reader.selections());
      continue;
    }
    const keyword = reader.identifier();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`an operation starts with query, mutation or subscription, not ${JSON.stringify(keyword)}`);
    }
    reader.skipOperationHeader();
    operations.push({ type: keyword, selections: reader.selections() });
  }
  return { operations, fragments };
}

function valueOf(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'var': {
      const key = node.value as string;
      return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : null;
    }
    case 'list':
      return (node.items ?? []).map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.key] = valueOf(field.value, variables);
      return out;
    }
    default:
      return node.value;
  }
}

// ---------------------------------------------------------------- execution

interface Context {
  readonly forge: Forge;
  readonly fragments: ReadonlyMap<string, readonly Selection[]>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly errors: { message: string; path: (string | number)[] }[];
}

interface Resolved {
  readonly type: string;
  readonly value: unknown;
}

const SCALARS = new Set(['ID', 'String', 'Int', 'Float', 'Boolean', 'URI', 'DateTime', 'GitObjectID', 'GitTimestamp', 'HTML', 'Base64String']);

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function flatten(ctx: Context, typeName: string, selections: readonly Selection[], into: FieldNode[]): void {
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name ?? '');
      if (fragment !== undefined) flatten(ctx, typeName, fragment, into);
      continue;
    }
    if (selection.kind === 'inline') {
      const condition = selection.typeCondition;
      if (condition === undefined || condition === typeName || condition === 'Node' || SCALARS.has(condition) || condition === 'Actor' || condition === 'RepositoryOwner') {
        flatten(ctx, typeName, selection.selections ?? [], into);
      }
      continue;
    }
    into.push(selection as FieldNode);
  }
}

function repoById(forge: Forge, id: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

/** A repository out of a global id (a mutation input) or a raw numeric database id. */
function repoOf(forge: Forge, id: unknown): Repo | null {
  if (typeof id === 'string' && id.startsWith('R_')) return repoById(forge, Number(id.slice(2)));
  return repoById(forge, asNumber(id, -1));
}

function repoOfIssue(forge: Forge, issue: Issue): Repo | null {
  for (const repo of forge.repos.values()) if (repo.issues.includes(issue)) return repo;
  return null;
}

function repoOfPull(forge: Forge, pull: Pull): Repo | null {
  for (const repo of forge.repos.values()) if (repo.pulls.includes(pull)) return repo;
  return null;
}

/** Decode an opaque global id into the node it names. */
function decodeId(forge: Forge, id: string): { __typename: string; value: unknown } | null {
  if (id.startsWith('R_')) {
    const repo = repoById(forge, Number(id.slice(2)));
    return repo === null ? null : { __typename: 'Repository', value: repo };
  }
  if (id.startsWith('I_')) {
    const parts = id.slice(2).split('_');
    const repo = repoById(forge, Number(parts[0]));
    const issue = repo === null ? undefined : forge.issue(repo, Number(parts[1]));
    return issue === undefined ? null : { __typename: 'Issue', value: issue };
  }
  if (id.startsWith('PR_')) {
    const parts = id.slice(3).split('_');
    const repo = repoById(forge, Number(parts[0]));
    const pull = repo === null ? undefined : forge.pull(repo, Number(parts[1]));
    return pull === undefined ? null : { __typename: 'PullRequest', value: pull };
  }
  return null;
}

/** The `node(id:)` field: the node's own concrete type, so its inline fragments resolve. */
function nodeField(forge: Forge, id: string): Resolved {
  const node = decodeId(forge, id);
  return node === null ? { type: 'Node', value: null } : { type: node.__typename, value: node.value };
}

function changedFiles(forge: Forge, repo: Repo, pull: Pull): PullFileView[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const mergeBase = forge.mergeBase(repo, baseTip, pull.headSha);
  const from = mergeBase === null ? null : forge.filesAt(repo, mergeBase);
  const to = forge.filesAt(repo, pull.headSha) ?? new Map();
  return forge.diff(repo, from, to);
}

interface PullFileView {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch: string;
}

function paginate<T>(items: T[], args: Record<string, unknown>): { nodes: T[]; totalCount: number; hasNextPage: boolean; endCursor: string | null; start: number } {
  const first = Math.max(1, Math.min(100, asNumber(args.first, 10)));
  const start = offsetOf(args.after);
  const nodes = items.slice(start, start + first);
  return { nodes, totalCount: items.length, hasNextPage: start + nodes.length < items.length, endCursor: nodes.length > 0 ? cursorOf(start + nodes.length) : null, start };
}

function caseConcrete(typeName: string): string {
  if (typeName === 'RepositoryOwner') return 'RepositoryOwner';
  return typeName;
}

// ---------------------------------------------------------------- resolvers

function resolveField(ctx: Context, typeName: string, field: FieldNode, parent: unknown): { resolved?: Resolved; error?: string } {
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(field.args)) args[key] = valueOf(field.args[key]!, ctx.variables);
  return resolve(ctx, typeName, field.name, args, parent);
}

function resolve(ctx: Context, typeName: string, name: string, args: Record<string, unknown>, parent: unknown): { resolved?: Resolved; error?: string } {
  const forge = ctx.forge;
  if (name === '__typename') return { resolved: { type: 'String', value: typeName } };
  switch (typeName) {
    case 'Query':
      switch (name) {
        case 'viewer':
          return { resolved: { type: 'User', value: forge.viewer } };
        case 'repository': {
          const repo = forge.get(asString(args.owner), asString(args.name));
          return { resolved: { type: 'Repository', value: repo ?? null } };
        }
        case 'node':
          return { resolved: nodeField(forge, asString(args.id)) };
        case 'search':
          return { resolved: { type: 'SearchResultItemConnection', value: null } };
        case '__type':
          return { resolved: { type: '__Type', value: introspect(asString(args.name)) } };
        case 'rateLimit':
          return { resolved: { type: 'RateLimit', value: null } };
        default:
          return { error: `Cannot query field "${name}" on type "Query".` };
      }
    case 'Mutation':
      switch (name) {
        case 'createIssue':
          return { resolved: { type: 'CreateIssuePayload', value: mutationCreateIssue(forge, args.input) } };
        case 'closeIssue':
          return { resolved: { type: 'CloseIssuePayload', value: mutationCloseIssue(forge, args.input) } };
        case 'createPullRequest':
          return { resolved: { type: 'CreatePullRequestPayload', value: mutationCreatePullRequest(forge, args.input) } };
        case 'mergePullRequest':
          return { resolved: { type: 'MergePullRequestPayload', value: mutationMergePullRequest(forge, args.input) } };
        case 'addComment':
          return { resolved: { type: 'AddCommentPayload', value: mutationAddComment(forge, args.input) } };
        default:
          return { error: `Cannot query field "${name}" on type "Mutation".` };
      }
    case 'Node': {
      const node = parent as { __typename: string; value: unknown } | null;
      if (node === null) return { resolved: { type: 'Node', value: null } };
      return resolve(ctx, node.__typename, name, args, node.value);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return { resolved: { type: 'Issue', value: (parent as { issue: Issue | null }).issue } };
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return { resolved: { type: 'PullRequest', value: (parent as { pullRequest: Pull | null }).pullRequest } };
    case 'AddCommentPayload': {
      const edge = (parent as { commentEdge: { node: unknown } | null }).commentEdge;
      if (name === 'commentEdge') return { resolved: { type: 'IssueCommentEdge', value: edge } };
      return { error: `Cannot query field "${name}" on type "AddCommentPayload".` };
    }
    case 'IssueCommentEdge':
      return { resolved: { type: 'IssueComment', value: (parent as { node: unknown } | null)?.node ?? null } };
    case 'User':
    case 'RepositoryOwner':
    case 'Actor': {
      const user = parent as { login: string; id: number; name: string } | null;
      if (user === null) return { resolved: { type: caseConcrete(typeName), value: null } };
      switch (name) {
        case 'login':
          return { resolved: { type: 'String', value: user.login } };
        case 'id':
          return { resolved: { type: 'ID', value: `U_${user.id}` } };
        case 'databaseId':
          return { resolved: { type: 'Int', value: user.id } };
        case 'name':
          return { resolved: { type: 'String', value: user.name } };
        case 'avatarUrl':
        case 'url':
        case 'email':
          return { resolved: { type: 'String', value: '' } };
        case 'isViewer':
          return { resolved: { type: 'Boolean', value: true } };
        default:
          return { error: `Cannot query field "${name}" on type "User".` };
      }
    }
    case 'Repository':
      return resolveRepository(ctx, name, args, parent);
    case 'Ref': {
      const ref = parent as { name: string; target: unknown } | null;
      if (ref === null) return { resolved: { type: 'Ref', value: null } };
      if (name === 'name') return { resolved: { type: 'String', value: ref.name } };
      if (name === 'prefix') return { resolved: { type: 'String', value: 'refs/heads/' } };
      if (name === 'target') return { resolved: { type: 'RefTarget', value: ref.target } };
      if (name === 'oid') return { resolved: { type: 'GitObjectID', value: ref.target } };
      return { error: `Cannot query field "${name}" on type "Ref".` };
    }
    case 'RefTarget':
      return { resolved: { type: 'GitObjectID', value: (parent as { target: unknown })?.target ?? null } };
    case 'Issue':
      return resolveIssue(ctx, name, args, parent);
    case 'IssueConnection': {
      const connection = parent as { nodes: Issue[]; totalCount: number; hasNextPage: boolean; endCursor: string | null; start: number } | null;
      if (connection === null) return { resolved: { type: 'IssueConnection', value: null } };
      if (name === 'nodes') return { resolved: { type: 'Issue', value: connection.nodes } };
      if (name === 'edges') return { resolved: { type: 'IssueEdge', value: connection.nodes.map((node, index) => ({ node, cursor: cursorOf(connection.start + index + 1) })) } };
      if (name === 'totalCount') return { resolved: { type: 'Int', value: connection.totalCount } };
      if (name === 'pageInfo') return { resolved: { type: 'PageInfo', value: { hasNextPage: connection.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: connection.endCursor } } };
      return { error: `Cannot query field "${name}" on type "IssueConnection".` };
    }
    case 'IssueEdge': {
      const edge = parent as { node: Issue; cursor: string };
      if (name === 'node') return { resolved: { type: 'Issue', value: edge.node } };
      if (name === 'cursor') return { resolved: { type: 'String', value: edge.cursor } };
      return { error: `Cannot query field "${name}" on type "IssueEdge".` };
    }
    case 'PullRequestConnection': {
      const connection = parent as { nodes: Pull[]; totalCount: number; hasNextPage: boolean; endCursor: string | null; start: number } | null;
      if (connection === null) return { resolved: { type: 'PullRequestConnection', value: null } };
      if (name === 'nodes') return { resolved: { type: 'PullRequest', value: connection.nodes } };
      if (name === 'edges') return { resolved: { type: 'PullRequestEdge', value: connection.nodes.map((node, index) => ({ node, cursor: cursorOf(connection.start + index + 1) })) } };
      if (name === 'totalCount') return { resolved: { type: 'Int', value: connection.totalCount } };
      if (name === 'pageInfo') return { resolved: { type: 'PageInfo', value: { hasNextPage: connection.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: connection.endCursor } } };
      return { error: `Cannot query field "${name}" on type "PullRequestConnection".` };
    }
    case 'PullRequestEdge': {
      const edge = parent as { node: Pull; cursor: string };
      if (name === 'node') return { resolved: { type: 'PullRequest', value: edge.node } };
      if (name === 'cursor') return { resolved: { type: 'String', value: edge.cursor } };
      return { error: `Cannot query field "${name}" on type "PullRequestEdge".` };
    }
    case 'PageInfo':
      return { resolved: { type: 'Boolean', value: (parent as Record<string, unknown>)[name] ?? null } };
    case 'PullRequestChangedFileConnection': {
      const value = parent as { nodes: PullFileView[] } | null;
      if (value === null) return { resolved: { type: 'PullRequestChangedFileConnection', value: null } };
      if (name === 'nodes') return { resolved: { type: 'PullRequestChangedFile', value: value.nodes } };
      if (name === 'totalCount') return { resolved: { type: 'Int', value: value.nodes.length } };
      if (name === 'edges') return { resolved: { type: 'PullRequestChangedFile', value: value.nodes } };
      return { error: `Cannot query field "${name}" on type "PullRequestChangedFileConnection".` };
    }
    case 'PullRequestChangedFile': {
      const file = parent as PullFileView | null;
      if (file === null) return { resolved: { type: 'String', value: null } };
      if (name === 'path') return { resolved: { type: 'String', value: file.filename } };
      if (name === 'additions') return { resolved: { type: 'Int', value: file.additions } };
      if (name === 'deletions') return { resolved: { type: 'Int', value: file.deletions } };
      if (name === 'changes') return { resolved: { type: 'Int', value: file.changes } };
      if (name === 'status') return { resolved: { type: 'String', value: file.status } };
      if (name === 'patch') return { resolved: { type: 'String', value: '' } };
      return { error: `Cannot query field "${name}" on type "PullRequestChangedFile".` };
    }
    case 'PullRequest':
      return resolvePullRequest(ctx, name, args, parent);
    case 'IssueComment': {
      const comment = parent as { id: string; body: string } | null;
      if (comment === null) return { resolved: { type: 'IssueComment', value: null } };
      if (name === 'id') return { resolved: { type: 'ID', value: comment.id } };
      if (name === 'body') return { resolved: { type: 'String', value: comment.body } };
      if (name === 'createdAt' || name === 'updatedAt') return { resolved: { type: 'DateTime', value: '' } };
      return { error: `Cannot query field "${name}" on type "IssueComment".` };
    }
    case 'PullRequestCommitConnection':
      return { resolved: { type: 'PullRequestCommit', value: [] } };
    case '__Type':
    case '__Field':
    case '__EnumValue':
    case '__InputValue':
      return resolveType(ctx, typeName, name, parent);
    default:
      return { error: `Cannot query field "${name}" on type "${caseConcrete(typeName)}".` };
  }
}

function resolveRepository(ctx: Context, name: string, args: Record<string, unknown>, parent: unknown): { resolved?: Resolved; error?: string } {
  const repo = parent as Repo | null;
  if (repo === null || repo === undefined) return { resolved: { type: 'Repository', value: null } };
  const forge = ctx.forge;
  switch (name) {
    case 'id':
      return { resolved: { type: 'ID', value: `R_${repo.id}` } };
    case 'databaseId':
      return { resolved: { type: 'Int', value: repo.id } };
    case 'name':
      return { resolved: { type: 'String', value: repo.name } };
    case 'nameWithOwner':
      return { resolved: { type: 'String', value: `${repo.owner}/${repo.name}` } };
    case 'owner':
      return { resolved: { type: 'RepositoryOwner', value: forge.viewer } };
    case 'defaultBranchRef': {
      const tip = forge.headOid(repo);
      return { resolved: { type: 'Ref', value: { name: repo.defaultBranch, target: tip } } };
    }
    case 'viewerPermission':
      return { resolved: { type: 'RepositoryPermission', value: 'ADMIN' } };
    case 'hasIssuesEnabled':
      return { resolved: { type: 'Boolean', value: true } };
    case 'isPrivate':
      return { resolved: { type: 'Boolean', value: repo.private } };
    case 'viewerHasPushAccess':
      return { resolved: { type: 'Boolean', value: true } };
    case 'issue': {
      const issue = forge.issue(repo, asNumber(args.number));
      return { resolved: { type: 'Issue', value: issue ?? null } };
    }
    case 'issues': {
      const states = Array.isArray(args.states) ? args.states.map((entry) => asString(entry).toUpperCase()) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const field = asString(orderBy.field, 'CREATED_AT').toUpperCase();
      const direction = asString(orderBy.direction, 'DESC').toUpperCase();
      let items = repo.issues.filter((issue) => states === null || states.includes(issue.state.toUpperCase()));
      items = [...items].sort((a, b) => {
        if (field === 'UPDATED_AT' && a.seq !== b.seq) return direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq;
        return direction === 'ASC' ? a.number - b.number : b.number - a.number;
      });
      return { resolved: { type: 'IssueConnection', value: paginate(items, args) } };
    }
    case 'pullRequest': {
      const pull = forge.pull(repo, asNumber(args.number));
      return { resolved: { type: 'PullRequest', value: pull ?? null } };
    }
    case 'pullRequests': {
      const states = Array.isArray(args.states) ? args.states.map((entry) => asString(entry).toUpperCase()) : null;
      let items = repo.pulls.filter((pull) => states === null || states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      items = [...items].sort((a, b) => b.number - a.number);
      return { resolved: { type: 'PullRequestConnection', value: paginate(items, args) } };
    }
    case 'description':
      return { resolved: { type: 'String', value: repo.description } };
    case 'url':
      return { resolved: { type: 'URI', value: `/${repo.owner}/${repo.name}` } };
    case 'createdAt':
    case 'updatedAt':
    case 'pushedAt':
      return { resolved: { type: 'DateTime', value: '' } };
    case 'stargazerCount':
    case 'forkCount':
      return { resolved: { type: 'Int', value: 0 } };
    default:
      return { error: `Cannot query field "${name}" on type "Repository".` };
  }
}

function resolveIssue(ctx: Context, name: string, args: Record<string, unknown>, parent: unknown): { resolved?: Resolved; error?: string } {
  const issue = parent as Issue | null;
  if (issue === null || issue === undefined) return { resolved: { type: 'Issue', value: null } };
  const forge = ctx.forge;
  switch (name) {
    case 'id':
      return { resolved: { type: 'ID', value: `I_${issue.repoId}_${issue.number}` } };
    case 'number':
      return { resolved: { type: 'Int', value: issue.number } };
    case 'title':
      return { resolved: { type: 'String', value: issue.title } };
    case 'body':
      return { resolved: { type: 'String', value: issue.body } };
    case 'state':
      return { resolved: { type: 'IssueState', value: issue.state === 'open' ? 'OPEN' : 'CLOSED' } };
    case 'labels':
      return {
        resolved: {
          type: 'IssueLabelConnection',
          value: { nodes: issue.labelNames.map((label) => ({ id: label, name: label, color: 'ededed', description: '' })), totalCount: issue.labelNames.length, hasNextPage: false, endCursor: null, start: 0 },
        },
      };
    case 'comments': {
      const repo = repoOfIssue(forge, issue);
      const nodes = repo === null ? [] : repo.comments.filter((comment) => comment.issue === issue.number).map((comment) => ({ id: `C_${comment.id}`, body: comment.body }));
      return { resolved: { type: 'IssueCommentConnection', value: { nodes, totalCount: nodes.length, hasNextPage: false, endCursor: null } } };
    }
    case 'author':
      return { resolved: { type: 'Actor', value: { login: issue.user, id: 1, name: issue.user } } };
    case 'createdAt':
    case 'updatedAt':
      return { resolved: { type: 'DateTime', value: '' } };
    case 'closedAt':
    case 'stateReason':
      return { resolved: { type: 'String', value: issue.closedAt } };
    case 'url':
      return { resolved: { type: 'URI', value: `/${issue.number}` } };
    case 'number_': {
      void args;
      return { resolved: { type: 'Int', value: issue.number } };
    }
    default:
      return { error: `Cannot query field "${name}" on type "Issue".` };
  }
}

function resolvePullRequest(ctx: Context, name: string, args: Record<string, unknown>, parent: unknown): { resolved?: Resolved; error?: string } {
  const pull = parent as Pull | null;
  if (pull === null || pull === undefined) return { resolved: { type: 'PullRequest', value: null } };
  const repo = repoOfPull(ctx.forge, pull);
  switch (name) {
    case 'id':
      return { resolved: { type: 'ID', value: `PR_${pull.repoId}_${pull.number}` } };
    case 'number':
      return { resolved: { type: 'Int', value: pull.number } };
    case 'title':
      return { resolved: { type: 'String', value: pull.title } };
    case 'body':
      return { resolved: { type: 'String', value: pull.body } };
    case 'state':
      return { resolved: { type: 'PullRequestState', value: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN' } };
    case 'merged':
      return { resolved: { type: 'Boolean', value: pull.merged } };
    case 'mergedAt':
      return { resolved: { type: 'DateTime', value: pull.mergedAt } };
    case 'headRefName':
      return { resolved: { type: 'String', value: pull.head } };
    case 'baseRefName':
      return { resolved: { type: 'String', value: pull.base } };
    case 'headRefOid':
    case 'headSha':
      return { resolved: { type: 'GitObjectID', value: pull.headSha } };
    case 'baseRefOid':
    case 'baseSha':
      return { resolved: { type: 'GitObjectID', value: pull.baseSha } };
    case 'mergeable':
      return { resolved: { type: 'MergeableState', value: 'MERGEABLE' } };
    case 'files': {
      const files = repo === null ? [] : changedFiles(ctx.forge, repo, pull);
      return { resolved: { type: 'PullRequestChangedFileConnection', value: { nodes: files } } };
    }
    case 'commits':
      return { resolved: { type: 'PullRequestCommitConnection', value: { nodes: [] } } };
    case 'head':
      return { resolved: { type: 'Ref', value: { name: pull.head, target: pull.headSha } } };
    case 'base':
      return { resolved: { type: 'Ref', value: { name: pull.base, target: pull.baseSha } } };
    case 'createdAt':
    case 'updatedAt':
    case 'closedAt':
      return { resolved: { type: 'DateTime', value: '' } };
    default:
      void args;
      return { error: `Cannot query field "${name}" on type "PullRequest".` };
  }
}

function resolveType(ctx: Context, typeName: string, name: string, parent: unknown): { resolved?: Resolved; error?: string } {
  void ctx;
  const node = parent as Record<string, unknown> | null;
  if (node === null) return { resolved: { type: typeName, value: null } };
  if (name === 'name') return { resolved: { type: 'String', value: node.name ?? null } };
  if (name === 'kind') return { resolved: { type: '__TypeKind', value: node.kind ?? null } };
  if (name === 'description') return { resolved: { type: 'String', value: node.description ?? null } };
  if (name === 'isDeprecated') return { resolved: { type: 'Boolean', value: node.deprecated === true } };
  if (name === 'deprecationReason') return { resolved: { type: 'String', value: null } };
  if (name === 'fields') return { resolved: { type: '__Field', value: Array.isArray(node.fields) ? node.fields : null } };
  if (name === 'enumValues') return { resolved: { type: '__EnumValue', value: Array.isArray(node.enumValues) ? node.enumValues : null } };
  if (name === 'inputFields') return { resolved: { type: '__InputValue', value: Array.isArray(node.inputFields) ? node.inputFields : null } };
  if (name === 'interfaces' || name === 'possibleTypes') return { resolved: { type: '__Type', value: Array.isArray(node[name]) ? (node[name] as unknown[]) : [] } };
  if (name === 'ofType' || name === 'type') return { resolved: { type: '__Type', value: null } };
  if (name === 'args') return { resolved: { type: '__InputValue', value: [] } };
  return { error: `Cannot query field "${name}" on type "${typeName}".` };
}

// ---------------------------------------------------------------- mutations

function mutationCreateIssue(forge: Forge, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>;
  const repo = repoOf(forge, args.repositoryId);
  if (repo === null) return { issue: null };
  return { issue: forge.createIssue(repo, asString(args.title), asString(args.body), []) };
}

function mutationCloseIssue(forge: Forge, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>;
  const target = decodeId(forge, asString(args.issueId));
  if (target === null || target.__typename !== 'Issue') return { issue: null };
  const issue = target.value as Issue;
  issue.state = 'closed';
  issue.closedAt = forge.nowIso();
  issue.cache = null;
  return { issue };
}

function mutationCreatePullRequest(forge: Forge, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>;
  const repo = repoOf(forge, args.repositoryId);
  if (repo === null) return { pullRequest: null };
  const head = asString(args.headRefName);
  const base = asString(args.baseRefName);
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return { pullRequest: null };
  return { pullRequest: forge.createPull(repo, { title: asString(args.title), body: asString(args.body), head, base, headSha, baseSha }) };
}

function mutationMergePullRequest(forge: Forge, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>;
  const target = decodeId(forge, asString(args.pullRequestId));
  if (target === null || target.__typename !== 'PullRequest') return { pullRequest: null };
  const pull = target.value as Pull;
  const repo = repoOfPull(forge, pull);
  if (repo === null) return { pullRequest: null };
  forge.mergePull(repo, pull);
  return { pullRequest: pull };
}

function mutationAddComment(forge: Forge, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>;
  const target = decodeId(forge, asString(args.subjectId));
  if (target === null || target.__typename !== 'Issue') return { commentEdge: null };
  const issue = target.value as Issue;
  const repo = repoOfIssue(forge, issue);
  if (repo === null) return { commentEdge: null };
  const comment = forge.addComment(repo, issue.number, asString(args.body));
  issue.cache = null;
  return { commentEdge: { node: { id: `C_${comment.id}`, body: comment.body } } };
}

// ---------------------------------------------------------------- introspection

interface IntrospectedType {
  readonly name: string;
  readonly kind: string;
  readonly description?: string;
  readonly fields?: { name: string; type: string; deprecated: boolean }[];
  readonly enumValues?: { name: string; description: string; deprecated: boolean }[];
  readonly inputFields?: { name: string; type: string; defaultValue: string | null }[];
  readonly interfaces?: string[];
  readonly possibleTypes?: string[];
}

function objectType(name: string, fields?: readonly string[]): IntrospectedType {
  return { name, kind: 'OBJECT', description: `${name} as this forge describes it`, ...(fields === undefined ? {} : { fields: fields.map((field) => ({ name: field, type: 'String', deprecated: false })) }) };
}

function enumType(name: string, values: readonly string[]): IntrospectedType {
  return { name, kind: 'ENUM', enumValues: values.map((value) => ({ name: value, description: '', deprecated: false })) };
}

function inputType(name: string, fields: readonly string[]): IntrospectedType {
  return { name, kind: 'INPUT_OBJECT', inputFields: fields.map((field) => ({ name: field, type: 'String', defaultValue: null })) };
}

const SCHEMA_TYPES: ReadonlyMap<string, IntrospectedType> = new Map(
  (
    [
      objectType('Issue', ['id', 'number', 'title', 'body', 'state', 'labels', 'comments', 'author', 'createdAt', 'updatedAt', 'closedAt', 'stateReason', 'url']),
      objectType('PullRequest', ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'commits', 'head', 'base', 'createdAt', 'updatedAt', 'author']),
      objectType('Repository', ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'viewerHasPushAccess', 'stargazerCount', 'forkCount']),
      objectType('User', ['id', 'databaseId', 'login', 'name', 'avatarUrl', 'url', 'email', 'isViewer']),
      objectType('RepositoryOwner', ['id', 'login', 'name', 'avatarUrl', 'url']),
      objectType('Ref', ['name', 'prefix', 'target', 'oid']),
      objectType('IssueConnection', ['nodes', 'edges', 'totalCount', 'pageInfo']),
      objectType('IssueEdge', ['node', 'cursor']),
      objectType('PullRequestConnection', ['nodes', 'edges', 'totalCount', 'pageInfo']),
      objectType('PullRequestEdge', ['node', 'cursor']),
      objectType('IssueLabel', ['id', 'name', 'color', 'description']),
      objectType('IssueLabelConnection', ['nodes', 'edges', 'totalCount']),
      objectType('IssueComment', ['id', 'body', 'author', 'createdAt', 'updatedAt']),
      objectType('IssueCommentConnection', ['nodes', 'edges', 'totalCount', 'pageInfo']),
      objectType('IssueCommentEdge', ['node', 'cursor']),
      objectType('PageInfo', ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
      objectType('PullRequestChangedFile', ['path', 'additions', 'deletions', 'changes', 'status', 'patch']),
      objectType('PullRequestChangedFileConnection', ['nodes', 'edges', 'totalCount']),
      objectType('PullRequestCommit', ['commit']),
      objectType('PullRequestCommitConnection', ['nodes', 'totalCount']),
      objectType('RepositoryConnection', ['nodes', 'totalCount']),
      objectType('SearchResultItemConnection', ['nodes', 'totalCount', 'pageInfo']),
      objectType('RateLimit', ['limit', 'remaining', 'used']),
      objectType('Query', ['viewer', 'repository', 'node', 'search', 'rateLimit']),
      objectType('Mutation', ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
      objectType('CreateIssuePayload', ['issue']),
      objectType('CloseIssuePayload', ['issue']),
      objectType('CreatePullRequestPayload', ['pullRequest']),
      objectType('MergePullRequestPayload', ['pullRequest']),
      objectType('AddCommentPayload', ['commentEdge']),
      objectType('__Type', ['name', 'kind', 'description', 'fields', 'interfaces', 'possibleTypes', 'enumValues', 'inputFields', 'ofType']),
      objectType('__Field', ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason']),
      objectType('__EnumValue', ['name', 'description', 'isDeprecated', 'deprecationReason']),
      objectType('__InputValue', ['name', 'description', 'type', 'defaultValue']),
      enumType('IssueState', ['OPEN', 'CLOSED']),
      enumType('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']),
      enumType('OrderDirection', ['ASC', 'DESC']),
      enumType('SearchType', ['ISSUE', 'REPOSITORY', 'USER', 'FILE', 'TOPIC']),
      enumType('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
      enumType('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']),
      enumType('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']),
      enumType('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
      inputType('CreateIssueInput', ['repositoryId', 'title', 'body', 'assigneeIds', 'labelIds']),
      inputType('CloseIssueInput', ['issueId', 'stateReason']),
      inputType('CreatePullRequestInput', ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft']),
      inputType('MergePullRequestInput', ['pullRequestId', 'mergeMethod', 'commitHeadline']),
      inputType('AddCommentInput', ['subjectId', 'body']),
    ] as IntrospectedType[]
  ).map((entry) => [entry.name, entry] as const),
);

function introspect(name: string): IntrospectedType | null {
  return SCHEMA_TYPES.get(name) ?? null;
}

// ---------------------------------------------------------------- executor

function executeSelections(ctx: Context, typeName: string, selections: readonly Selection[], parent: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields: FieldNode[] = [];
  flatten(ctx, typeName, selections, fields);
  for (const field of fields) {
    const resolved = resolveField(ctx, typeName, field, parent);
    if (resolved.error !== undefined) {
      ctx.errors.push({ message: resolved.error, path: [field.alias] });
      out[field.alias] = null;
      continue;
    }
    const value = resolved.resolved;
    if (value === undefined || value.value === null) {
      out[field.alias] = null;
      continue;
    }
    if (SCALARS.has(value.type)) {
      out[field.alias] = value.value;
      continue;
    }
    if (field.selections.length === 0) {
      out[field.alias] = value.value;
      continue;
    }
    // A list of objects resolves one item at a time (a connection's nodes, __type's fields).
    if (Array.isArray(value.value)) {
      out[field.alias] = value.value.map((item) =>
        item === null || item === undefined ? null : executeSelections(ctx, value.type, field.selections, item),
      );
      continue;
    }
    out[field.alias] = executeSelections(ctx, value.type, field.selections, value.value);
  }
  return out;
}

/** Run one operation's document and answer its {data, errors} envelope. */
export function executeOperation(
  forge: Forge,
  document: Document,
  variables: Readonly<Record<string, unknown>>,
): { data: unknown; errors: { message: string; path: (string | number)[] }[] } {
  const ctx: Context = { forge, fragments: document.fragments, variables, errors: [] };
  const operation = document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'the document holds no operation', path: [] }] };
  const data = executeSelections(ctx, operation.type === 'mutation' ? 'Mutation' : 'Query', operation.selections, null);
  return { data, errors: ctx.errors };
}

/** POST /api/graphql: one operation, or a batch of them answered in order. */
export function handleGraphQL(res: ServerResponse, forge: Forge, raw: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    restReply(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const answer = (operation: Record<string, unknown>): { data: unknown; errors?: { message: string; path: (string | number)[] }[] } => {
    const query = typeof operation.query === 'string' ? operation.query : '';
    const variables = (typeof operation.variables === 'object' && operation.variables !== null ? operation.variables : {}) as Record<string, unknown>;
    if (query === '') return { data: null, errors: [{ message: 'the request carries no query', path: [] }] };
    let document: Document;
    try {
      document = parseDocument(query);
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message, path: [] }] };
    }
    const result = executeOperation(forge, document, variables);
    return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
  };
  if (Array.isArray(parsed)) {
    restReply(res, 200, parsed.map((entry) => (typeof entry === 'object' && entry !== null ? answer(entry as Record<string, unknown>) : { data: null })));
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    restReply(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const result = answer(parsed as Record<string, unknown>);
  restReply(res, 200, result.errors !== undefined ? { data: result.data, errors: result.errors } : { data: result.data });
}
