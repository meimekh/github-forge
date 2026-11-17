// scripts/bench-read.mjs: measures the entry's own read and write paths with three clients, so it is
// clear how much of the benchmark's wall time is the suite's client overhead and how much is the
// server. Not part of the scoring path; `node scripts/bench-read.mjs`.

import { createServer as netServer } from 'node:net';
import { request as httpRequest, Agent } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const token = process.env.MAKEFUN_SHOP_TOKEN ?? 'mf-bench-token-0001';
process.env.MAKEFUN_SHOP_TOKEN = token;

const { createApp } = await import(pathToFileURL(resolve(repo, 'app.ts')).href);
const server = createApp();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' };

async function jsonCall(path, init) {
  const response = await fetch(`${base}${path}`, init);
  return response.json();
}

const created = await jsonCall('/api/v3/user/repos', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bench', private: true }) });
const owner = created.owner.login;
const issue = await jsonCall(`/api/v3/repos/${owner}/bench/issues`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'bench issue', body: 'body' }) });
const issuePath = `/api/v3/repos/${owner}/bench/issues/${issue.number}`;

const ops = 2000;
const rounds = 3;

/** The suite's client shape: global fetch, a fresh AbortController and a timer per call. */
async function fetchLoop() {
  for (let index = 0; index < ops; index += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${base}${issuePath}`, { headers: auth, signal: controller.signal });
    const text = await response.text();
    JSON.parse(text);
    clearTimeout(timer);
  }
}

/** One keep-alive socket, raw http.request, no fetch machinery. */
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
function rawLoop() {
  return new Promise((done, fail) => {
    let index = 0;
    const step = () => {
      if (index >= ops) {
        done();
        return;
      }
      index += 1;
      const request = httpRequest({ host: '127.0.0.1', port, path: issuePath, agent, headers: auth }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          JSON.parse(text);
          step();
        });
      });
      request.on('error', fail);
      request.end();
    };
    step();
  });
}

async function time(label, fn) {
  const roundsMs = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    await fn();
    roundsMs.push(Math.round(performance.now() - started));
  }
  roundsMs.sort((a, b) => a - b);
  process.stdout.write(`${label.padEnd(28)} ${String(roundsMs[1]).padStart(7)} ms  rounds ${JSON.stringify(roundsMs)}\n`);
  return roundsMs[1];
}

const writeOps = 200;
async function fetchWriteLoop() {
  for (let index = 0; index < writeOps; index += 1) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/v3/repos/${owner}/bench/issues`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: `bench ${index}`, body: 'body' }),
      signal: controller.signal,
    });
    const text = await response.text();
    JSON.parse(text);
  }
}

const fetchMs = await time(`read: fetch (${ops} GETs)`, fetchLoop);
const rawMs = await time(`read: raw http (${ops} GETs)`, rawLoop);
const writeMs = await time(`write: fetch (${writeOps} creates)`, fetchWriteLoop);
process.stdout.write(`\nserver-side share of the fetch loop: ~${Math.max(0, fetchMs - rawMs)} ms\n`);

server.close();
void netServer;
void writeMs;
