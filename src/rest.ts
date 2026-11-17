// rest.ts: the GitHub REST v3 surface — repositories, git refs, branches, commits, contents, labels,
// issues, comments and pull requests. Every reply is JSON, carries a fresh X-GitHub-Request-Id and the
// token's scopes, and a repository belongs to the login the token names (another owner is 404).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, type Comment, type Issue, type Label, type Pull, type Repo, type User, type PullFile } from './store.ts';
import { isOid, nextRequestId, sendJson, sendEmpty, sendRaw, JSON_TYPE } from './util.ts';

const SCOPE_HEADER = 'repo, read:org';
const PER_PAGE_DEFAULT = 30;

/** One REST reply: JSON plus the two headers every reply carries. */
export function reply(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const extra: Record<string, string> = {
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': SCOPE_HEADER,
  };
  if (headers !== undefined) for (const key of Object.keys(headers)) extra[key] = headers[key];
  sendJson(res, status, body, extra);
}

/** A REST error: a JSON body with a string message. */
export function replyError(res: ServerResponse, status: number, message: string): void {
  reply(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

/** A 204 with the request id and nothing else. */
export function replyNoContent(res: ServerResponse, status = 204): void {
  sendEmpty(res, status, { 'x-github-request-id': nextRequestId(), 'x-oauth-scopes': SCOPE_HEADER });
}

/** Answer with an already-serialized JSON body (the cached issue view, on the hot read path). */
export function replyRaw(res: ServerResponse, status: number, body: string, headers?: Record<string, string>): void {
  const extra: Record<string, string> = { 'x-github-request-id': nextRequestId(), 'x-oauth-scopes': SCOPE_HEADER };
  if (headers !== undefined) for (const key of Object.keys(headers)) extra[key] = headers[key];
  sendRaw(res, status, body, JSON_TYPE, extra);
}

export function notFound(res: ServerResponse): void {
  replyError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- serializers

export function userJson(forge: Forge, login: string): Record<string, unknown> {
  const user: User = forge.viewer;
  return {
    login,
    id: user.id,
    node_id: `U_${user.id}`,
    avatar_url: `http://avatars.invalid/u/${login}`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `/api/v3/users/${login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: `${login}@example.invalid`,
  };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(forge, repo.owner),
    html_url: `/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.createdAt),
    pushed_at: isoOf(repo.createdAt),
    git_url: `/${repo.owner}/${repo.name}.git`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge:${repo.owner}/${repo.name}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    forks: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
    allow_forking: true,
    is_template: false,
        org: userJson(forge, repo.owner),
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.repoId}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames.map((name) => labelJson(forge.label(repo, name) ?? { id: 0, name, color: 'ededed', description: '' })),
    assignees: [],
    assignee: null,
    user: userJson(forge, issue.user),
    comments: repo.comments.filter((comment) => comment.issue === issue.number).length,
    created_at: isoOf(issue.seq),
    updated_at: isoOf(issue.seq),
    closed_at: issue.closedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    state_reason: null,
    locked: false,
    active_lock_reason: null,
    draft: false,
  };
}

/** The issue's serialization, cached until something changes it. */
export function issueText(forge: Forge, repo: Repo, issue: Issue): string {
  if (issue.cache === null) issue.cache = JSON.stringify(issueJson(forge, repo, issue));
  return issue.cache;
}

export function commentJson(forge: Forge, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(forge, comment.user),
    created_at: isoOf(comment.seq),
    updated_at: isoOf(comment.seq),
    url: '',
    html_url: '',
    issue_url: '',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const head = { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, user: userJson(forge, repo.owner), repo: repoJson(forge, repo) };
  const base = { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, user: userJson(forge, repo.owner), repo: repoJson(forge, repo) };
  const files = filesOf(forge, repo, pull);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return {
    id: pull.id,
    node_id: `PR_${pull.repoId}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head,
    base,
    user: userJson(forge, pull.user),
    created_at: isoOf(pull.seq),
    updated_at: isoOf(pull.seq),
    closed_at: pull.mergedAt,
    draft: false,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    commits: 1,
    additions,
    deletions,
    changed_files: files.length,
    _links: {},
    mergeable: true,
  };
}

/** The changed files of a pull request, from its merge base to its head. */
export function filesOf(forge: Forge, repo: Repo, pull: Pull): PullFile[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const mergeBase = forge.mergeBase(repo, baseTip, pull.headSha);
  const from = mergeBase === null ? null : forge.filesAt(repo, mergeBase);
  const to = forge.filesAt(repo, pull.headSha) ?? new Map();
  return forge.diff(repo, from, to);
}

function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------- small readers

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The absolute origin of a request, for Link headers and URLs. */
function originOf(req: IncomingMessage): string {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : '127.0.0.1';
  return `http://${host}`;
}

function paginate<T>(items: T[], query: Map<string, string>): { page: T[]; link: string | null } {
  const perPage = Math.min(100, positiveInt(query.get('per_page'), PER_PAGE_DEFAULT));
  const page = positiveInt(query.get('page'), 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  return { page: slice, link: hasNext ? String(page + 1) : null };
}

// ---------------------------------------------------------------- the router

/** What one REST request needs. */
export interface RestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly forge: Forge;
  readonly segments: string[];
  readonly query: Map<string, string>;
  readonly body: Buffer;
}

/** Parse a JSON request body; answers null when it is malformed and a 400 has been sent. */
export function jsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return asRecord(parsed) ?? {};
  } catch {
    return null;
  }
}

/** Route one /api/v3 request. Answers true when it was handled. */
export function handleV3(context: RestContext): boolean {
  const { res, forge, segments, query } = context;
  if (segments.length === 0) {
    reply(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/settings/connections/applications',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      rate_limit_url: '/api/v3/rate_limit',
      meta_url: '/api/v3/meta',
    });
    return true;
  }
  if (segments[0] === 'meta') {
    reply(res, 200, { installed_version: '1.0.0', name: 'makefun-forge', verifiable_password_authentication: false });
    return true;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    reply(res, 200, userJson(forge, forge.viewer.login));
    return true;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) return userRepos(context);
  if (segments[0] === 'repos' && segments.length >= 3) return repoRoutes(context);
  notFound(res);
  return true;
}

/** GET/POST /user/repos */
function userRepos(context: RestContext): boolean {
  const { req, res, forge, query, body } = context;
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const all = forge.owned(forge.viewer.login);
    const { page, link } = paginate(all, query);
    const headers: Record<string, string> = {};
    if (link !== null) {
      const perPage = query.get('per_page') ?? String(PER_PAGE_DEFAULT);
      headers.link = `<${originOf(req)}/api/v3/user/repos?per_page=${perPage}&page=${link}>; rel="next", <${originOf(req)}/api/v3/user/repos?per_page=${perPage}&page=${link}>; rel="last"`;
    }
    reply(res, 200, page.map((repo) => repoJson(forge, repo)), headers);
    return true;
  }
  if (method === 'POST') {
    const parsed = jsonBody(body);
    if (parsed === null) {
      replyError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const name = asString(parsed.name).trim();
    if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      replyError(res, 422, 'Repository creation failed: the name is invalid');
      return true;
    }
    if (forge.get(forge.viewer.login, name) !== undefined) {
      replyError(res, 422, `Repository creation failed. "name" already exists on this account`);
      return true;
    }
    const repo = forge.create(forge.viewer.login, name, asString(parsed.description), asBool(parsed.private));
    reply(res, 201, repoJson(forge, repo), { location: `/api/v3/repos/${repo.owner}/${repo.name}` });
    return true;
  }
  replyError(res, 405, 'Method Not Allowed');
  return true;
}

/** Everything under /repos/{owner}/{repo}. */
function repoRoutes(context: RestContext): boolean {
  const { req, res, forge, segments, query } = context;
  const method = req.method ?? 'GET';
  const owner = segments[1]!;
  const name = segments[2]!;
  const repo = forge.get(owner, name);
  if (repo === undefined || repo.owner !== forge.viewer.login) {
    notFound(res);
    return true;
  }
  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') {
      reply(res, 200, repoJson(forge, repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = jsonBody(context.body);
      if (parsed === null) {
        replyError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof parsed.description === 'string') repo.description = parsed.description;
      if (typeof parsed.name === 'string' && parsed.name !== '' && parsed.name !== repo.name) repo.name = parsed.name;
      if (typeof parsed.private === 'boolean') repo.private = parsed.private;
      reply(res, 200, repoJson(forge, repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.remove(owner, name);
      replyNoContent(res);
      return true;
    }
    replyError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const out: unknown[] = [];
      for (const ref of forge.listRefs(repo)) {
        if (!ref.name.startsWith('refs/heads/')) continue;
        out.push({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid, url: `/api/v3/repos/${owner}/${name}/commits/${ref.oid}` }, protected: false });
      }
      reply(res, 200, out);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const ref = repo.refs.get(`refs/heads/${rest[1]}`);
      if (ref === undefined) {
        notFound(res);
        return true;
      }
      reply(res, 200, { name: rest[1], commit: { sha: ref, url: '' }, protected: false });
      return true;
    }
  }
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return commitsRoute(context, repo);
  if (rest[0] === 'contents') return contentsRoute(context, repo, rest.slice(1));
  if (rest[0] === 'git' && rest[1] === 'refs') return refsRoute(context, repo, rest.slice(2));
  if (rest[0] === 'labels') return labelsRoute(context, repo);
  if (rest[0] === 'issues') return issuesRoute(context, repo, rest.slice(1));
  if (rest[0] === 'pulls') return pullsRoute(context, repo, rest.slice(1));
  notFound(res);
  return true;
}

function commitsRoute(context: RestContext, repo: Repo): boolean {
  const { req, res, forge, query } = context;
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = forge.commitOf(repo, ref);
  if (tip === null) {
    reply(res, 200, []);
    return true;
  }
  const commits = forge.commitsFrom(repo, [tip]);
  const out = commits.map((entry) => {
    const object = repo.objects.get(entry.oid)!;
    const parsed = parseAuthorLine(object.data);
    return {
      sha: entry.oid,
      node_id: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${entry.oid}`,
      html_url: '',
      commit: {
        message: entry.message.replace(/\n$/, ''),
        author: { name: parsed.name, email: parsed.email, date: isoOf(parsed.stamp) },
        committer: { name: parsed.name, email: parsed.email, date: isoOf(parsed.stamp) },
        tree: { sha: forge.treeOf(repo, entry.oid) ?? '' },
        url: '',
        comment_count: 0,
      },
      author: userJson(forge, repo.owner),
      committer: userJson(forge, repo.owner),
      parents: [],
    };
  });
  reply(res, 200, out);
  return true;
}

function parseAuthorLine(data: Buffer): { name: string; email: string; stamp: number } {
  const text = data.toString('utf8', 0, Math.min(data.length, 4096));
  const match = /committer ([^<]*)<([^>]*)> (\d+)/.exec(text);
  if (match === null) return { name: repoDefaultName, email: '', stamp: 0 };
  return { name: (match[1] ?? '').trim(), email: match[2] ?? '', stamp: Number(match[3]) };
}

const repoDefaultName = 'makefun';

/** GET/POST /repos/{o}/{r}/git/refs and GET /repos/{o}/{r}/git/refs/heads/{branch} */
function refsRoute(context: RestContext, repo: Repo, rest: string[]): boolean {
  const { req, res, forge, body } = context;
  const method = req.method ?? 'GET';
  if (rest.length === 0 && method === 'POST') {
    const parsed = jsonBody(body);
    if (parsed === null) {
      replyError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const ref = asString(parsed.ref);
    const sha = asString(parsed.sha);
    if (!ref.startsWith('refs/heads/') || !isOid(sha)) {
      replyError(res, 422, 'Validation Failed: ref and sha are required');
      return true;
    }
    if (repo.refs.has(ref)) {
      replyError(res, 422, `Reference already exists: ${ref}`);
      return true;
    }
    if (!repo.objects.has(sha)) {
      replyError(res, 422, `The object ${sha} does not exist`);
      return true;
    }
    repo.refs.set(ref, sha);
    reply(res, 201, { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${ref.slice(11)}`, object: { sha, type: 'commit', url: '' } });
    return true;
  }
  if (rest.length === 1 && method === 'GET') {
    const ref = repo.refs.get(rest[0]!);
    if (ref === undefined) {
      notFound(res);
      return true;
    }
    reply(res, 200, { ref: rest[0], node_id: `REF_${rest[0]}`, url: '', object: { sha: ref, type: 'commit', url: '' } });
    return true;
  }
  if (rest.length >= 2 && rest[0] === 'heads' && method === 'GET') {
    const branch = rest.slice(1).join('/');
    const ref = repo.refs.get(`refs/heads/${branch}`);
    if (ref === undefined) {
      notFound(res);
      return true;
    }
    reply(res, 200, { ref: `refs/heads/${branch}`, node_id: `REF_${branch}`, url: '', object: { sha: ref, type: 'commit', url: '' } });
    return true;
  }
  notFound(res);
  return true;
}

/** GET/PUT/DELETE /repos/{o}/{r}/contents/{path} */
function contentsRoute(context: RestContext, repo: Repo, rest: string[]): boolean {
  const { req, res, forge, query, body } = context;
  const method = req.method ?? 'GET';
  const path = rest.join('/');
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const files = forge.filesAt(repo, ref);
    if (files === null) {
      reply(res, 200, []);
      return true;
    }
    if (path !== '') {
      const entry = files.get(path);
      if (entry !== undefined) {
        const object = repo.objects.get(entry.oid);
        const data = object?.data ?? Buffer.alloc(0);
        reply(res, 200, {
          name: path.slice(path.lastIndexOf('/') + 1),
          path,
          sha: entry.oid,
          size: data.length,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html_url: '',
          git_url: '',
          download_url: null,
          type: 'file',
          content: data.toString('base64'),
          encoding: 'base64',
          _links: {},
        });
        return true;
      }
    }
    const prefix = path === '' ? '' : `${path}/`;
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const [file, entry] of files) {
      if (!file.startsWith(prefix)) continue;
      const tail = file.slice(prefix.length);
      const slash = tail.indexOf('/');
      if (slash < 0) {
        out.push({ name: tail, path: file, sha: entry.oid, size: 0, type: 'file', url: '' });
      } else {
        const dir = tail.slice(0, slash);
        if (seen.has(dir)) continue;
        seen.add(dir);
        out.push({ name: dir, path: `${prefix}${dir}`, sha: entry.oid, size: 0, type: 'dir', url: '' });
      }
    }
    if (out.length === 0) {
      notFound(res);
      return true;
    }
    out.sort((a, b) => {
      const left = (a as { name: string }).name;
      const right = (b as { name: string }).name;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    reply(res, 200, out);
    return true;
  }
  const parsed = jsonBody(body);
  if (parsed === null) {
    replyError(res, 400, 'Problems parsing JSON');
    return true;
  }
  if (path === '') {
    replyError(res, 422, 'Validation Failed: a path is required');
    return true;
  }
  if (method === 'PUT') {
    const branch = asString(parsed.branch, repo.defaultBranch);
    if (!repo.refs.has(`refs/heads/${branch}`) && branch !== repo.defaultBranch) {
      replyError(res, 422, `Branch not found: ${branch}`);
      return true;
    }
    const content = asString(parsed.content);
    const data = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const givenSha = asString(parsed.sha);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const existing = tip === undefined ? undefined : forge.fileAt(repo, tip, path);
    if (givenSha !== '') {
      if (existing === undefined || existing.oid !== givenSha) {
        replyError(res, 409, `Content is not up to date for ${path}`);
        return true;
      }
    }
    const written = forge.writeFile(repo, { branch, path, data, message: asString(parsed.message, 'Update') });
    const status = givenSha !== '' ? 200 : 201;
    reply(res, status, {
      content: { name: path.slice(path.lastIndexOf('/') + 1), path, sha: written.blob, size: data.length, type: 'file', encoding: 'base64', content, url: '', git_url: '', html_url: '', _links: {} },
      commit: {
        sha: written.commit,
        node_id: written.commit,
        url: '',
        html_url: '',
        message: asString(parsed.message, 'Update'),
        author: { name: forge.viewer.name, email: forge.viewer.email, date: isoOf(repo.createdAt) },
        committer: { name: forge.viewer.name, email: forge.viewer.email, date: isoOf(repo.createdAt) },
        tree: { sha: forge.treeOf(repo, written.commit) ?? '' },
        parents: tip === undefined ? [] : [{ sha: tip }],
      },
    });
    return true;
  }
  if (method === 'DELETE') {
    const branch = asString(parsed.branch, repo.defaultBranch);
    const commit = forge.deleteFile(repo, { branch, path, message: asString(parsed.message, 'Delete') });
    if (commit === null) {
      notFound(res);
      return true;
    }
    reply(res, 200, { content: null, commit: { sha: commit, node_id: commit, message: asString(parsed.message, 'Delete'), url: '', html_url: '' } });
    return true;
  }
  replyError(res, 405, 'Method Not Allowed');
  return true;
}

/** GET/POST /repos/{o}/{r}/labels */
function labelsRoute(context: RestContext, repo: Repo): boolean {
  const { req, res, forge, body } = context;
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    reply(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
    return true;
  }
  if (method === 'POST') {
    const parsed = jsonBody(body);
    if (parsed === null) {
      replyError(res, 400, 'Problems parsing JSON');
      return true;
    }
    const name = asString(parsed.name).trim();
    if (name === '') {
      replyError(res, 422, 'Validation Failed: name is required');
      return true;
    }
    const label = forge.createLabel(repo, name, asString(parsed.color, 'ededed'), asString(parsed.description));
    reply(res, 201, labelJson(label));
    return true;
  }
  replyError(res, 405, 'Method Not Allowed');
  return true;
}

/** GET/POST /repos/{o}/{r}/issues, GET/PATCH one, and its comments. */
function issuesRoute(context: RestContext, repo: Repo, rest: string[]): boolean {
  const { req, res, forge, query, body } = context;
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const direction = query.get('direction') ?? (query.get('sort') === 'updated' ? 'asc' : 'desc');
      items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page } = paginate(items, query);
      reply(res, 200, page.map((issue) => issueJson(forge, repo, issue)));
      return true;
    }
    if (method === 'POST') {
      const parsed = jsonBody(body);
      if (parsed === null) {
        replyError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const labels = Array.isArray(parsed.labels) ? parsed.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      for (const name of labels) {
        if (forge.label(repo, name) === undefined) {
          replyError(res, 422, `Validation Failed: the label ${JSON.stringify(name)} does not exist`);
          return true;
        }
      }
      const issue = forge.createIssue(repo, asString(parsed.title), asString(parsed.body), labels);
      reply(res, 201, issueJson(forge, repo, issue));
      return true;
    }
    replyError(res, 405, 'Method Not Allowed');
    return true;
  }
  const number = Number.parseInt(rest[0]!, 10);
  const issue = Number.isFinite(number) ? forge.issue(repo, number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) {
      notFound(res);
      return true;
    }
    if (method === 'GET') {
      // The hot read path: an unchanged issue answers its cached bytes.
      replyRaw(res, 200, issueText(forge, repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = jsonBody(body);
      if (parsed === null) {
        replyError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (parsed.state === 'open' || parsed.state === 'closed') {
        issue.state = parsed.state;
        issue.closedAt = parsed.state === 'closed' ? isoOf(forge.nowSec()) : null;
      }
      if (typeof parsed.title === 'string') issue.title = parsed.title;
      if (typeof parsed.body === 'string') issue.body = parsed.body;
      if (Array.isArray(parsed.labels)) {
        const names = parsed.labels.filter((entry): entry is string => typeof entry === 'string');
        issue.labelNames = names;
      }
      issue.cache = null;
      reply(res, 200, issueJson(forge, repo, issue));
      return true;
    }
    replyError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) {
      notFound(res);
      return true;
    }
    if (method === 'GET') {
      const comments = repo.comments.filter((comment) => comment.issue === issue.number);
      reply(res, 200, comments.map((comment) => commentJson(forge, comment)));
      return true;
    }
    if (method === 'POST') {
      const parsed = jsonBody(body);
      if (parsed === null) {
        replyError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const comment = forge.addComment(repo, issue.number, asString(parsed.body));
      issue.cache = null;
      reply(res, 201, commentJson(forge, comment));
      return true;
    }
  }
  notFound(res);
  return true;
}

/** GET/POST /repos/{o}/{r}/pulls, one pull, its files and its merge. */
function pullsRoute(context: RestContext, repo: Repo, rest: string[]): boolean {
  const { req, res, forge, query, body } = context;
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const items = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const sorted = [...items].sort((a, b) => b.number - a.number);
      const { page } = paginate(sorted, query);
      reply(res, 200, page.map((pull) => pullJson(forge, repo, pull)));
      return true;
    }
    if (method === 'POST') {
      const parsed = jsonBody(body);
      if (parsed === null) {
        replyError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const headRef = asString(parsed.head).replace(/^[^:]*:/, '');
      const baseRef = asString(parsed.base).replace(/^[^:]*:/, '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        replyError(res, 422, 'Validation Failed: the head or base branch does not exist');
        return true;
      }
      const pull = forge.createPull(repo, {
        title: asString(parsed.title),
        body: asString(parsed.body),
        head: headRef,
        base: baseRef,
        headSha,
        baseSha,
      });
      reply(res, 201, pullJson(forge, repo, pull));
      return true;
    }
    replyError(res, 405, 'Method Not Allowed');
    return true;
  }
  const number = Number.parseInt(rest[0]!, 10);
  const pull = Number.isFinite(number) ? forge.pull(repo, number) : undefined;
  if (rest.length === 1) {
    if (pull === undefined || method !== 'GET') {
      if (pull !== undefined && method !== 'GET') {
        replyError(res, 405, 'Method Not Allowed');
        return true;
      }
      notFound(res);
      return true;
    }
    reply(res, 200, pullJson(forge, repo, pull));
    return true;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return true;
    }
    reply(res, 200, filesOf(forge, repo, pull));
    return true;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      notFound(res);
      return true;
    }
    const parsed = jsonBody(body) ?? {};
    const result = forge.mergePull(repo, pull);
    if (!result.ok) {
      if (result.reason === 'conflict') {
        replyError(res, 405, 'Pull Request is not mergeable');
        return true;
      }
      if (result.reason === 'merged') {
        replyError(res, 405, 'Pull Request has already been merged');
        return true;
      }
      notFound(res);
      return true;
    }
    void parsed;
    reply(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }
  notFound(res);
  return true;
}
