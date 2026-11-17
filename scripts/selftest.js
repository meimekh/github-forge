// scripts/selftest.js: run the real suite (the kit's sealed env) against this entry, locally, and
// report every check's verdict plus the four benchmark timings. Nothing is fabricated: the numbers it
// prints are the env's own export (state.json / perf.json) and its own log lines.
//
//   node scripts/selftest.js            # one full trial, prints the summary
//   node scripts/selftest.js --keep     # keep the state directory and print its path
//   node scripts/selftest.js --json     # print the export as JSON only
//
// It binds the env to a free ephemeral port of its own, starts the entry against it with the same
// bearer token, waits for the env to say done, reads the export and kills both children by PID.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const KIT = resolve(repo, '..', '..', 'mf-current', 'ghclone', 'github-core-clone-01-kit');
const ENV_SCRIPT = join(KIT, 'program', 'env', 'server.mjs');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const jsonOnly = argv.includes('--json');

/** The trial token both sides read; the entry compares the Authorization header with it. */
const token = 'mf-selftest-4f3a91c2d7e8b650';
/** The trial's wall budget, seconds: the env's internal deadline is this less 90 s. */
const wallSec = Number(process.env.SELFTEST_WALL_SEC ?? 900);
/** How long this script waits for the whole trial before giving up. */
const overallTimeoutMs = Number(process.env.SELFTEST_TIMEOUT_MS ?? 12 * 60_000);

function freePort() {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => done(port));
    });
  });
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Collect a child's output, keeping the last N lines and the whole log for the report. */
function collect(child) {
  const log = { out: [], err: [] };
  child.stdout.on('data', (chunk) => log.out.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => log.err.push(chunk.toString('utf8')));
  return log;
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'ghforge-selftest-'));
  const port = await freePort();
  const envUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const step = (line) => process.stdout.write(`[selftest] ${line}\n`);

  step(`kit      ${KIT}`);
  step(`state    ${stateDir}`);
  step(`env port ${port}`);

  const envProcess = spawn(process.execPath, [ENV_SCRIPT], {
    cwd: repo,
    env: {
      ...process.env,
      MAKEFUN_STATE_DIR: stateDir,
      MAKEFUN_ENV_HOST: '127.0.0.1',
      MAKEFUN_ENV_PORT: String(port),
      MAKEFUN_SHOP_TOKEN: token,
      MAKEFUN_TRIAL_WALL_BUDGET_SEC: String(wallSec),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const envLog = collect(envProcess);

  const readyFile = join(stateDir, 'ready');
  const readyDeadline = Date.now() + 30_000;
  while (!existsSync(readyFile) && Date.now() < readyDeadline) await sleep(50);
  if (!existsSync(readyFile)) {
    step('the env never wrote its ready file');
    envProcess.kill();
    process.exitCode = 1;
    return;
  }
  step('env ready; starting the entry');

  const entryProcess = spawn(process.execPath, ['--experimental-strip-types', 'main.ts'], {
    cwd: repo,
    env: {
      ...process.env,
      MAKEFUN_ENV_URL: envUrl,
      MAKEFUN_SHOP_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entryLog = collect(entryProcess);
  let entryExited = false;
  entryProcess.on('exit', () => {
    entryExited = true;
  });
  let envExited = false;
  envProcess.on('exit', () => {
    envExited = true;
  });

  const deadline = Date.now() + overallTimeoutMs;
  while (Date.now() < deadline) {
    if (entryExited) break;
    if (envExited) break;
    await sleep(500);
  }
  if (!entryExited) {
    step('the entry did not exit in time; killing it by PID');
    entryProcess.kill();
    await sleep(500);
    if (!entryExited) entryProcess.kill('SIGKILL');
  }

  const statePath = join(stateDir, 'export', 'state.json');
  const perfPath = join(stateDir, 'export', 'perf.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const perf = existsSync(perfPath) ? JSON.parse(readFileSync(perfPath, 'utf8')) : null;

  const details = new Map();
  for (const line of envLog.err.join('').split('\n')) {
    const match = /^\[env\] (\S+) (pass|fail)(?:\s+—\s+(.*))?$/.exec(line);
    if (match !== null) details.set(match[1], `${match[2]}${match[3] === undefined ? '' : ` — ${match[3]}`}`);
  }

  if (!envExited) {
    step('stopping the env by PID');
    envProcess.kill();
    await sleep(1000);
    if (!envExited) envProcess.kill('SIGKILL');
  }

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify({ state, perf }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${entryLog.out.join('')}${entryLog.err.join('')}`);
    process.stdout.write(`\n${envLog.out.join('')}`);
    if (state !== null) {
      process.stdout.write(`checks   ${state.counts.passed}/${state.counts.total}  working=${state.working}\n`);
      for (const [group, counts] of Object.entries(state.counts.byGroup)) {
        process.stdout.write(`  ${group.padEnd(9)} ${counts.passed}/${counts.total}\n`);
      }
      const failed = Object.entries(state.checks)
        .filter(([, bit]) => bit === 0)
        .map(([id]) => id);
      if (failed.length > 0) {
        process.stdout.write(`\nfailed checks (${failed.length}):\n`);
        for (const id of failed) process.stdout.write(`  ${id.padEnd(34)} ${details.get(id) ?? '(no detail logged)'}\n`);
      } else {
        process.stdout.write('\nevery check passed\n');
      }
    } else {
      process.stdout.write('no state.json was written\n');
    }
    if (perf !== null) {
      process.stdout.write(`\nperf     ${perf.points_total} points  calibrated=${perf.calibrated}\n`);
      for (const workload of perf.workloads ?? []) {
        process.stdout.write(`  ${workload.name.padEnd(6)} p50 ${String(workload.p50_ms).padStart(10)} ms  rounds ${JSON.stringify(workload.rounds_ms)}  points ${workload.points}\n`);
      }
      if (perf.perf_p50_us !== undefined) process.stdout.write(`  perf_p50_us ${perf.perf_p50_us}\n`);
      if (perf.notes !== undefined && perf.notes.length > 0) process.stdout.write(`  notes ${JSON.stringify(perf.notes)}\n`);
    } else {
      process.stdout.write('no perf.json was written\n');
    }
    process.stdout.write(`\nelapsed  ${Math.round((Date.now() - started) / 1000)} s\n`);
  }

  if (!keep) {
    step('removing the state directory');
    const { rmSync } = await import('node:fs');
    rmSync(stateDir, { recursive: true, force: true });
  } else {
    step(`kept ${stateDir}`);
  }
}

void main().catch((err) => {
  process.stderr.write(`[selftest] ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
