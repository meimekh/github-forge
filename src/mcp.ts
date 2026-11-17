// mcp.ts: the Model Context Protocol endpoint at /mcp — JSON-RPC 2.0 over the Streamable HTTP
// transport. It speaks revision 2026-07-28 (server/discover, every request declaring its revision in
// _meta) and still answers the earlier handshake (initialize + notifications/initialized). The tools
// act on the same store REST reads back, so an object created over MCP is the same object over REST.

import type { ServerResponse } from 'node:http';
import type { Forge, Repo } from './store.ts';
import { reply } from './rest.ts';
import { messageOf } from './util.ts';

/** The revision this server prefers. */
export const PROTOCOL_REVISION = '2026-07-28';
/** Every revision server/discover lists. */
export const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
/** The server's identity, in server/discover and initialize alike. */
export const SERVER_INFO: Readonly<{ name: string; version: string }> = Object.freeze({ name: 'makefun-github-forge', version: '1.0.0' });
/** The JSON-RPC codes the transport and the suite name. */
const PARSE_ERROR = -32700;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;

interface ToolProperty {
  readonly type: string;
  readonly description?: string;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, ToolProperty>>;
    readonly required: readonly string[];
    readonly additionalProperties: boolean;
  };
}

function tool(name: string, description: string, properties: Record<string, ToolProperty>, required: readonly string[]): ToolDefinition {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({ type: 'object' as const, properties: Object.freeze(properties), required: Object.freeze([...required]), additionalProperties: false }),
  });
}

const STRING = (description: string): ToolProperty => ({ type: 'string', description });
const BOOLEAN = (description: string): ToolProperty => ({ type: 'boolean', description });

/** The tools tools/list offers: the six the contest names, plus three the forge makes useful. */
export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository in the forge. Answers the created repository, including its full_name.',
    { name: STRING('The repository name, without an owner.'), description: STRING('A short description of the repository.'), private: BOOLEAN('Whether the repository is private.'), owner: STRING('The login that owns the repository; defaults to the token owner.') },
    ['name'],
  ),
  tool(
    'get_repo',
    'Read one repository by owner and name. Answers the repository object, or an error when it does not exist.',
    { owner: STRING('The repository owner login.'), repo: STRING('The repository name.') },
    ['owner', 'repo'],
  ),
  tool(
    'list_repos',
    'List the repositories the token owner can read, newest creation order last.',
    { owner: STRING('The login whose repositories to list; defaults to the token owner.') },
    [],
  ),
  tool(
    'create_issue',
    'Open an issue in a repository. Answers the created issue with its number and its global id.',
    { owner: STRING('The repository owner login.'), repo: STRING('The repository name.'), title: STRING('The issue title.'), body: STRING('The issue body.') },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List a repository\'s issues, optionally filtered by state (open, closed or all).',
    { owner: STRING('The repository owner login.'), repo: STRING('The repository name.'), state: STRING('The state to filter by: open, closed or all.') },
    ['owner', 'repo'],
  ),
  tool(
    'get_issue',
    'Read one issue of a repository by its number.',
    { owner: STRING('The repository owner login.'), repo: STRING('The repository name.'), number: ({ type: 'number', description: 'The issue number.' } as ToolProperty) },
    ['owner', 'repo', 'number'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch. Answers the created pull request.',
    { owner: STRING('The repository owner login.'), repo: STRING('The repository name.'), title: STRING('The pull request title.'), body: STRING('The pull request body.'), head: STRING('The branch the change comes from.'), base: STRING('The branch the change goes into.') },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge an open pull request by its number. Answers the merged pull request and its merge commit.',
    { owner: STRING('The repository owner login.'), repo: STRING('The repository name.'), pull_number: ({ type: 'number', description: 'The pull request number.' } as ToolProperty) },
    ['owner', 'repo', 'pull_number'],
  ),
]);

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface ToolResult {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

function toolResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

/** Resolve a repository argument to the token owner's repository, or null. */
function repoOf(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = text(args.owner) || forge.viewer.login;
  const name = text(args.repo) || text(args.name) || text(args.repository);
  if (name === '') return null;
  const repo = forge.get(owner, name);
  return repo === undefined || repo.owner !== forge.viewer.login ? null : repo;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = text(args.name) || text(args.repo) || text(args.repository);
      if (repoName === '') return toolError('the name argument is required');
      const owner = text(args.owner) || forge.viewer.login;
      if (owner !== forge.viewer.login) return toolError(`the token owner cannot create repositories for ${owner}`);
      const existing = forge.get(owner, repoName);
      if (existing !== undefined) return toolError(`the repository ${owner}/${repoName} already exists`);
      const repo = forge.create(owner, repoName, text(args.description), args.private === true);
      return toolResult(repoSummary(forge, repo));
    }
    case 'get_repo': {
      const repo = repoOf(forge, args);
      if (repo === null) return toolError('the repository was not found');
      return toolResult(repoSummary(forge, repo));
    }
    case 'list_repos': {
      const owner = text(args.owner) || forge.viewer.login;
      return toolResult({ repositories: forge.owned(owner).map((repo) => repoSummary(forge, repo)) });
    }
    case 'create_issue': {
      const repo = repoOf(forge, args);
      if (repo === null) return toolError('the repository was not found');
      const title = text(args.title);
      if (title === '') return toolError('the title argument is required');
      const issue = forge.createIssue(repo, title, text(args.body), []);
      return toolResult({ id: `I_${issue.repoId}_${issue.number}`, number: issue.number, title: issue.title, body: issue.body, state: 'open', repository: `${repo.owner}/${repo.name}` });
    }
    case 'list_issues': {
      const repo = repoOf(forge, args);
      if (repo === null) return toolError('the repository was not found');
      const state = text(args.state) || 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolResult({
        repository: `${repo.owner}/${repo.name}`,
        state,
        count: issues.length,
        issues: issues.map((issue) => ({ id: `I_${issue.repoId}_${issue.number}`, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labelNames })),
      });
    }
    case 'get_issue': {
      const repo = repoOf(forge, args);
      if (repo === null) return toolError('the repository was not found');
      const issue = forge.issue(repo, num(args.number));
      if (issue === undefined) return toolError('the issue was not found');
      return toolResult({ id: `I_${issue.repoId}_${issue.number}`, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labelNames });
    }
    case 'create_pull_request': {
      const repo = repoOf(forge, args);
      if (repo === null) return toolError('the repository was not found');
      const head = text(args.head) || text(args.head_ref) || text(args.head_branch);
      const base = text(args.base) || text(args.base_ref) || text(args.base_branch);
      if (head === '' || base === '') return toolError('the head and base arguments are required');
      const headSha = repo.refs.get(`refs/heads/${head.replace(/^[^:]*:/, '')}`);
      const baseSha = repo.refs.get(`refs/heads/${base.replace(/^[^:]*:/, '')}`);
      if (headSha === undefined || baseSha === undefined) return toolError(`the branch ${headSha === undefined ? head : base} does not exist`);
      const pull = forge.createPull(repo, {
        title: text(args.title),
        body: text(args.body),
        head: head.replace(/^[^:]*:/, ''),
        base: base.replace(/^[^:]*:/, ''),
        headSha,
        baseSha,
      });
      return toolResult(pullSummary(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf(forge, args);
      if (repo === null) return toolError('the repository was not found');
      const number = num(args.pull_number ?? args.number ?? args.pull_request_number);
      const pull = Number.isFinite(number) ? forge.pull(repo, number) : undefined;
      if (pull === undefined) return toolError('the pull request was not found');
      const merged = forge.mergePull(repo, pull);
      if (!merged.ok) return toolError(merged.reason === 'conflict' ? 'the pull request is not mergeable' : 'the pull request could not be merged');
      return toolResult({ ...pullSummary(repo, pull), merged: true, state: 'closed', merge_commit_sha: merged.sha });
    }
    case 'list_pulls': {
      const repo = repoOf(forge, args);
      if (repo === null) return toolError('the repository was not found');
      return toolResult({ repository: `${repo.owner}/${repo.name}`, pull_requests: repo.pulls.map((pull) => pullSummary(repo, pull)) });
    }
    default:
      return toolError(`the tool ${name} does not exist`);
  }
}

function repoSummary(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    viewer_permission: 'ADMIN',
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    created_at: new Date(repo.createdAt * 1000).toISOString().replace('.000Z', 'Z'),
    visibility: repo.private ? 'private' : 'public',
    forge: forge.viewer.login,
  };
}

function pullSummary(repo: Repo, pull: { number: number; repoId: number; title: string; body: string; state: string; merged: boolean; head: string; base: string; headSha: string; baseSha: string; mergeCommitSha: string | null }): Record<string, unknown> {
  return {
    id: `PR_${pull.repoId}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merge_commit_sha: pull.mergeCommitSha,
    repository: `${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** The server/discover result (2026-07-28). */
function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: { listChanged: false }, logging: {}, prompts: {}, resources: {} },
    serverInfo: { ...SERVER_INFO },
    instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
    _meta: {
      'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
      'io.modelcontextprotocol/protocolVersion': PROTOCOL_REVISION,
    },
  };
}

/** The initialize result (the handshake revisions). */
function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  const requested = text(params.protocolVersion);
  const revision = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_REVISION;
  return {
    protocolVersion: revision,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { ...SERVER_INFO },
    instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
  };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

/** POST /mcp. The caller has already checked the bearer token. */
export function handleMcp(res: ServerResponse, forge: Forge, raw: Buffer): void {
  const bodyText = raw.toString('utf8').trim();
  if (bodyText === '') {
    reply(res, 400, rpcError(null, PARSE_ERROR, 'Parse error: the body is empty'));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    reply(res, 400, rpcError(null, PARSE_ERROR, `Parse error: ${messageOf(err)}`));
    return;
  }
  const batch = Array.isArray(parsed) ? parsed : [parsed];
  const answers: (Record<string, unknown> | null)[] = [];
  for (const entry of batch) {
    answers.push(handleOne(forge, asRecord(entry)));
  }
  const response = Array.isArray(parsed) ? answers.filter((entry) => entry !== null) : answers[0];
  if (response === null || response === undefined) {
    reply(res, 202, {});
    return;
  }
  reply(res, 200, response);
}

function handleOne(forge: Forge, request: JsonRpcRequest): Record<string, unknown> | null {
  const method = text(request.method);
  const id = request.id;
  const params = asRecord(request.params);
  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize':
      return rpcResult(id, initializeResult(params));
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = text(params.name);
      if (name === '') return rpcError(id, INVALID_PARAMS, 'tools/call needs a tool name');
      const toolName = TOOLS.find((entry) => entry.name === name)?.name;
      if (toolName === undefined) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      const args = asRecord(params.arguments);
      try {
        return rpcResult(id, callTool(forge, toolName, args));
      } catch (err) {
        return rpcResult(id, toolError(`the tool failed: ${messageOf(err)}`));
      }
    }
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    default:
      if (method === '') return rpcError(id, METHOD_NOT_FOUND, 'the request names no method');
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}
