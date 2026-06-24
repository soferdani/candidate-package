/**
 * One-shot importer: schema -> COPY 4 CSVs -> indexes -> smoke counts.
 * COPY (CSV) handles quoted fields, embedded commas/quotes, and treats empty
 * unquoted fields as NULL — exactly what this dataset needs (see docs/04).
 *
 * Run: npm run db:setup   (from src/)
 */
import { readFileSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { pool } from '../server/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

async function runSqlFile(name: string) {
  const sql = readFileSync(join(__dirname, name), 'utf8');
  await pool.query(sql);
}

async function copyCsv(table: string, columns: string, file: string) {
  const client = await pool.connect();
  try {
    const sql = `COPY ${table} (${columns}) FROM STDIN WITH (FORMAT csv, HEADER true)`;
    const dbStream = client.query(copyFrom(sql));
    const fileStream = createReadStream(join(DATA_DIR, file));
    await pipeline(fileStream, dbStream);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
    console.log(`  ${table.padEnd(12)} ${rows[0].n} rows`);
  } finally {
    client.release();
  }
}

async function main() {
  console.log('1) schema...');
  await runSqlFile('schema.sql');

  console.log('2) loading CSVs (FK order)...');
  await copyCsv('categories', 'id, name, parent_id', 'categories.csv');
  await copyCsv('suppliers', 'id, name, email, rating, country, active, created_at', 'suppliers.csv');
  await copyCsv('products', 'id, name, category_id, sku, price', 'products.csv');
  await copyCsv(
    'orders',
    'id, supplier_id, product_id, quantity, unit_price, total_price, status, priority, created_at, updated_at, warehouse, notes',
    'orders.csv',
  );

  console.log('3) indexes + analyze...');
  await runSqlFile('indexes.sql');

  console.log('4) smoke checks (expect 50000 / 500 / 5000 / 1512 / 507 / 208):');
  const checks: [string, string][] = [
    ['orders', 'SELECT count(*)::int n FROM orders'],
    ['suppliers', 'SELECT count(*)::int n FROM suppliers'],
    ['products', 'SELECT count(*)::int n FROM products'],
    ['unassigned wh', "SELECT count(*)::int n FROM orders WHERE warehouse IS NULL OR warehouse=''"],
    ['negative qty', 'SELECT count(*)::int n FROM orders WHERE quantity < 0'],
    ['ts anomalies', 'SELECT count(*)::int n FROM orders WHERE updated_at < created_at'],
  ];
  for (const [label, sql] of checks) {
    const { rows } = await pool.query(sql);
    console.log(`  ${label.padEnd(14)} ${rows[0].n}`);
  }

  await pool.end();
  console.log('done.');
}

main().catch((err) => {
  console.error('import failed:', err);
  process.exit(1);
});
