const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');

// All configuration comes from environment variables (set in docker-compose.yml).
// The pg driver reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE itself.
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const PORT = Number(required('PORT'));
const REDIS_URL = required('REDIS_URL');
const CACHE_TTL_SECONDS = Number(required('CACHE_TTL_SECONDS'));
const CACHE_KEY = 'products:all';

const db = new Pool({ max: 10 });
const cache = createClient({ url: REDIS_URL });
cache.on('error', (err) => console.error(`Redis error: ${err.message}`));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// List products: served from Redis when cached, otherwise from PostgreSQL (cache-aside).
app.get('/products', async (req, res, next) => {
  try {
    const cached = await cache.get(CACHE_KEY);
    if (cached) return res.json({ source: 'cache', products: JSON.parse(cached) });

    const { rows } = await db.query('SELECT id, name, price FROM products ORDER BY id');
    await cache.set(CACHE_KEY, JSON.stringify(rows), { EX: CACHE_TTL_SECONDS });
    res.json({ source: 'database', products: rows });
  } catch (err) {
    next(err);
  }
});

app.get('/products/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, name, price FROM products WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.post('/products', async (req, res, next) => {
  const { name, price } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || !(Number(price) > 0)) {
    return res.status(400).json({ error: 'name (string) and price (> 0) are required' });
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO products (name, price) VALUES ($1, $2) RETURNING id, name, price',
      [name.trim(), price],
    );
    await cache.del(CACHE_KEY); // the cached list is now out of date
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Healthy only when both PostgreSQL and Redis respond. Used by the Docker HEALTHCHECK.
app.get('/healthz', async (req, res) => {
  try {
    await Promise.all([db.query('SELECT 1'), cache.ping()]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Creates the table and adds sample products the first time the service starts.
const migrate = async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL CHECK (price > 0)
  )`);
  await db.query(`INSERT INTO products (name, price)
    SELECT * FROM (VALUES ('Maize seed 10kg', 15000.00), ('Fertiliser 50kg', 32000.00), ('Knapsack sprayer', 25000.00)) AS seed(name, price)
    WHERE NOT EXISTS (SELECT 1 FROM products)`);
};

const start = async () => {
  await cache.connect();
  await migrate();
  const server = app.listen(PORT, () => console.log(`product-service listening on port ${PORT}`));

  // Docker sends SIGTERM on `docker stop`; finish in-flight requests, close connections, then exit.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await Promise.allSettled([db.end(), cache.close()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((err) => {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
