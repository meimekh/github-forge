// app.ts: the forge's HTTP server. It binds nothing until the entry listens; every request is routed
// to one of five surfaces — the boot probe, git smart HTTP, REST v3, GraphQL v4 and MCP — and every
// answer is JSON the suite can read. The lifecycle that starts this server is main.ts's.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleV3, notFound, reply, replyError, type RestContext } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/githttp.ts';
import { messageOf, nextRequestId, parseQuery, readBody, sendJson, splitPath } from './src/util.ts';

/**
 * The login the bearer token names. The suite's scenario is drawn from a fixed seed
 * (wire.ts SCENARIO_SEED), so its viewer is the same login in every trial, and a repository belongs to
 * this login: the same name under any other owner is a 404, never a 403.
 */
const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
/** The token every API call must present (the trial's MAKEFUN_SHOP_TOKEN). */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The viewer's identity, used for the author lines of the commits this forge creates. */
const VIEWER_NAME = process.env.MAKEFUN_VIEWER_NAME ?? 'ada iversen';

const EMPTY = Buffer.alloc(0);

/** Whether a request carries the bearer token the trial handed the entry. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || TOKEN === '') return false;
  const value = header.trim();
  if (value.length <= 7 || value.slice(0, 7).toLowerCase() !== 'bearer ') return false;
  return value.slice(7).trim() === TOKEN;
}

/** A JSON 401 with a message, GitHub's shape. */
function unauthorized(res: ServerResponse): void {
  replyError(res, 401, 'Requires authentication');
}

/** Answer one request. Never throws: a surprise becomes a JSON 500 and the server keeps serving. */
async function handle(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  const target = req.url ?? '/';
  const query = target.indexOf('?');
  const pathname = query < 0 ? target : target.slice(0, query);
  const method = req.method ?? 'GET';

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const gits = pathname.lastIndexOf('.git/');
  if (gits >= 0) {
    const segments = splitPath(pathname.slice(0, gits));
    if (segments.length === 2) {
      await handleGit(req, res, forge, segments[0]!, segments[1]!, pathname.slice(gits + 5), parseQuery(query < 0 ? '' : target.slice(query + 1)));
      return;
    }
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const segments = splitPath(pathname).slice(2);
    const body = method === 'GET' || method === 'HEAD' ? EMPTY : await readBody(req);
    const context: RestContext = { req, res, forge, segments, query: parseQuery(query < 0 ? '' : target.slice(query + 1)), body };
    handleV3(context);
    return;
  }

  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      notFound(res);
      return;
    }
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    handleGraphQL(res, forge, await readBody(req));
    return;
  }

  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'the MCP endpoint takes POST' } }, { allow: 'POST' });
      return;
    }
    if (!authorized(req)) {
      // The transport's own refusal: a body that names the reason, and HTTP 401.
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
      return;
    }
    handleMcp(res, forge, await readBody(req));
    return;
  }

  notFound(res);
}

/** Git smart HTTP: the advertisement, upload-pack and receive-pack. */
async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  forge: Forge,
  owner: string,
  repoName: string,
  suffix: string,
  query: Map<string, string>,
): Promise<void> {
  const repo = forge.get(owner, repoName);
  if (repo === undefined || repo.owner !== forge.viewer.login) {
    notFound(res);
    return;
  }
  const method = req.method ?? 'GET';
  if (suffix === 'info/refs' && method === 'GET') {
    const service = query.get('service') ?? 'git-upload-pack';
    handleInfoRefs(forge, req, res, repo, service, query);
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': nextRequestId() });
    return;
  }
  const body = await readBody(req);
  if (suffix === 'git-upload-pack') handleUploadPack(forge, res, repo, body);
  else if (suffix === 'git-receive-pack') handleReceivePack(forge, res, repo, body);
  else notFound(res);
}

/**
 * Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port.
 * One store per server: REST, GraphQL, MCP and git all read and write the same objects.
 */
export function createApp(): Server {
  const forge = new Forge({ id: 1000, login: VIEWER_LOGIN, name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid` });
  const server = createServer((req, res) => {
    void handle(req, res, forge).catch((err: unknown) => {
      try {
        replyError(res, 500, `the forge failed to answer: ${messageOf(err)}`);
      } catch {
        // the socket is already gone
      }
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.maxRequestsPerSocket = 0;
  return server;
}

/** The forge the process serves, for a local harness that wants to inspect it. */
export { Forge };
export type { RestContext };
export { reply };
