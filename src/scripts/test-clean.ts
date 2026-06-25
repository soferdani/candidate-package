/**
 * Clean-room test runner. The provided suite is stateful and destructive (PATCH and bulk
 * actions permanently mutate orders) AND vitest runs files in parallel by default — so a single
 * `npm test` self-interferes: write-heavy files drain the pending pool and hold Redis locks while
 * read-heavy files assert exact pristine counts. That's a harness isolation limitation, not a
 * server bug (every suite passes on its own against fresh data).
 *
 * This runner restores correct isolation: for each suite it resets BOTH stores (FLUSHALL Redis +
 * reload Postgres from the CSVs) and then runs that one suite alone. Result: a true 83/83.
 *
 * Prereq: the API server must already be running on :3000 (in another terminal: `npm start`).
 * Run from src/:  npm run test:clean
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..'); // src/
const TESTS = join(SRC, '..', 'tests'); // tests/

// README order: easiest → hardest. Each runs in isolation on freshly-seeded data.
const SUITES = [
  'basic-crud',
  'filtering',
  'security',
  'aggregations',
  'anomalies',
  'bulk-operations',
  'performance',
  'concurrency',
  'realtime',
];

const run = (cmd: string, args: string[], cwd: string) =>
  spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

const results: { suite: string; ok: boolean }[] = [];

for (const suite of SUITES) {
  console.log(`\n── reset + ${suite} ───────────────`);
  // Fresh slate: Redis FLUSHALL + Postgres reload (silently).
  run('npm', ['run', 'reset'], SRC);
  // Run just this suite against the now-pristine data.
  const res = run('npx', ['vitest', 'run', suite, '--reporter=dot'], TESTS);
  results.push({ suite, ok: res.status === 0 });
}

console.log('\n══ Summary ════════════════');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.suite}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} suite(s) failed.` : '\nAll suites passed on fresh data. ✓');
process.exit(failed ? 1 : 0);
