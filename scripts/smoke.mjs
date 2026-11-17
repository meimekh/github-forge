// scripts/smoke.mjs: a fast in-process smoke test of the entry's own surface (no env, no suite). It
// starts createApp() on an ephemeral port, walks the REST, git, GraphQL and MCP surfaces with one
// real request each and prints the status and a snippet, so a syntax or wiring break shows up in
// seconds instead of after a full trial. `node scripts/smoke.mjs`.

import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const token = (process.env.MAKEFUN_SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'mf-smoke-token-0001');

const { createApp } = await import(pathToFileURL(resolve(repo, 'app.ts')).href);

const server = createApp();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${token}` };
const json = { ...auth, 'content-type': 'application/json' };

let failures = 0;
async function call(label, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  const ok = label.startsWith('expect-') ? true : true;
  process.stdout.write(`${String(response.status).padEnd(4)} ${label.padEnd(46)} ${text.slice(0, 150).replace(/\n/g, ' ')}\n`);
  void ok;
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

function check(label, condition) {
  process.stdout.write(`${condition ? 'ok  ' : 'FAIL'} ${label}\n`);
  if (!condition) failures += 1;
}

const health = await fetch(`${base}/healthz`);
check('/healthz is 200', health.status === 200);

const created = await call('POST /api/v3/user/repos', '/api/v3/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ name: 'smoke-repo', private: true, description: 'smoke' }) });
check('create repo is 201', created.status === 201);
const owner = created.body.owner.login;

const read = await call('GET /api/v3/repos/{o}/{r}', `/api/v3/repos/${owner}/smoke-repo`, { headers: auth });
check('repo reads back with default_branch', read.body.default_branch === 'main');

const file = await call('PUT contents', `/api/v3/repos/${owner}/smoke-repo/contents/docs/readme.md`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ message: 'add readme', content: Buffer.from('hello forge\n').toString('base64') }),
});
check('contents create is 201', file.status === 201);

const got = await call('GET contents', `/api/v3/repos/${owner}/smoke-repo/contents/docs/readme.md`, { headers: auth });
check('contents round-trip', Buffer.from(got.body.content, 'base64').toString('utf8') === 'hello forge\n');

const issue = await call('POST issues', `/api/v3/repos/${owner}/smoke-repo/issues`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'smoke issue', body: 'body' }) });
check('issue create is 201', issue.status === 201);

const anon = await call('GET repo without a token', `/api/v3/repos/${owner}/smoke-repo`, {});
check('no token is 401', anon.status === 401);

const nope = await call('GET an unknown route', '/api/v3/no-such-route', { headers: auth });
check('unknown route is a JSON 404', nope.status === 404 && nope.body.message === 'Not Found');

const malformed = await call('POST malformed JSON', '/api/v3/user/repos', { method: 'POST', headers: json, body: '{"name":' });
check('malformed body is 400', malformed.status === 400);

const refs = await call('GET info/refs (v2)', `/${owner}/smoke-repo.git/info/refs?service=git-upload-pack`, { headers: { ...auth, 'git-protocol': 'version=2' } });
check('v2 advertisement', refs.status === 200);

const gql = await call('POST /api/graphql viewer', '/api/graphql', { method: 'POST', headers: json, body: JSON.stringify({ query: 'query { viewer { login } }' }) });
check('graphql viewer login', gql.body.data.viewer.login === owner);

const mcp = await call('POST /mcp tools/list', '/mcp', { method: 'POST', headers: json, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
check('mcp lists at least six tools', Array.isArray(mcp.body.result?.tools) && mcp.body.result.tools.length >= 6);

const mcpAuth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('mcp without a token is 401', mcpAuth.status === 401);

server.close();
process.stdout.write(`\n${failures === 0 ? 'smoke: all checks passed' : `smoke: ${failures} check(s) failed`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
