const express = require('express');
const { Pool } = require('pg');

// All configuration comes from environment variables (set in docker-compose.yml).
// The pg driver reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE itself.
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const PORT = Number(required('PORT'));
const PRODUCT_SERVICE_URL = required('PRODUCT_SERVICE_URL');

const db = new Pool({ max: 10 });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/orders', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM orders ORDER BY id DESC LIMIT 100');
    res.json({ orders: rows });
  } catch (err) {
    next(err);
  }
});

// Orders move forward only: pending -> paid -> delivered. Pending or paid orders can be cancelled.
const NEXT_STATUSES = {
  pending: ['paid', 'cancelled'],
  paid: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

const orderId = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Order id must be a positive integer' });
    return null;
  }
  return id;
};

app.get('/orders/:id', async (req, res, next) => {
  const id = orderId(req, res);
  if (id === null) return;
  try {
    const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Creates an order. The price is taken from the product service, never from the client.
app.post('/orders', async (req, res, next) => {
  const productId = Number(req.body?.productId);
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'productId and quantity (integer >= 1) are required' });
  }
  try {
    const r = await fetch(`${PRODUCT_SERVICE_URL}/products/${productId}`, { signal: AbortSignal.timeout(3000) });
    if (r.status === 404) return res.status(400).json({ error: `Product ${productId} does not exist` });
    if (!r.ok) return res.status(502).json({ error: 'Product service unavailable' });
    const product = await r.json();

    const { rows } = await db.query(
      `INSERT INTO orders (product_id, product_name, quantity, total_price)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [product.id, product.name, quantity, Number(product.price) * quantity],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Changes an order's status, e.g. {"status":"paid"}. Only the moves in NEXT_STATUSES are allowed.
app.patch('/orders/:id', async (req, res, next) => {
  const id = orderId(req, res);
  if (id === null) return;
  const status = req.body?.status;
  if (!Object.hasOwn(NEXT_STATUSES, status)) {
    return res.status(400).json({ error: `status must be one of: ${Object.keys(NEXT_STATUSES).join(', ')}` });
  }
  const allowedFrom = Object.keys(NEXT_STATUSES).filter((from) => NEXT_STATUSES[from].includes(status));
  try {
    // The WHERE clause makes the check and the update one atomic step.
    const { rows } = await db.query(
      `UPDATE orders SET status = $2, updated_at = now()
       WHERE id = $1 AND status = ANY($3) RETURNING *`,
      [id, status, allowedFrom],
    );
    if (rows.length > 0) return res.json(rows[0]);

    const current = await db.query('SELECT status FROM orders WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.status(409).json({ error: `A ${current.rows[0].status} order can't be marked ${status}` });
  } catch (err) {
    next(err);
  }
});

// Healthy only when PostgreSQL responds. Used by the Docker HEALTHCHECK.
app.get('/healthz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// The ALTER statements add the status columns to an orders table created by an older version.
const migrate = () => db.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    total_price NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'delivered', 'cancelled'));
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
`);

const start = async () => {
  await migrate();
  const server = app.listen(PORT, () => console.log(`order-service listening on port ${PORT}`));

  // Docker sends SIGTERM on `docker stop`; finish in-flight requests, close connections, then exit.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await db.end().catch(() => {});
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
