const express = require('express');

// All configuration comes from environment variables (set in docker-compose.yml).
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const PORT = Number(required('PORT'));
const PRODUCT_SERVICE_URL = required('PRODUCT_SERVICE_URL');
const ORDER_SERVICE_URL = required('ORDER_SERVICE_URL');
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 5000);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Forwards the request to a downstream service and relays its response.
const proxy = (baseUrl, stripPrefix) => async (req, res) => {
  const path = req.originalUrl.replace(stripPrefix, '') || '/';
  try {
    const upstream = await fetch(`${baseUrl}${path}`, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    res.status(upstream.status).type('application/json').send(await upstream.text());
  } catch (err) {
    console.error(`Upstream ${baseUrl} failed: ${err.message}`);
    res.status(502).json({ error: 'Upstream service unavailable' });
  }
};

app.use('/api/products', proxy(PRODUCT_SERVICE_URL, '/api'));
app.use('/api/orders', proxy(ORDER_SERVICE_URL, '/api'));

// Shows whether each downstream service is healthy.
app.get('/api/status', async (req, res) => {
  const check = async (url) => {
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
      return r.ok ? 'up' : 'down';
    } catch {
      return 'down';
    }
  };
  const [products, orders] = await Promise.all([check(PRODUCT_SERVICE_URL), check(ORDER_SERVICE_URL)]);
  const healthy = products === 'up' && orders === 'up';
  res.status(healthy ? 200 : 503).json({ gateway: 'up', products, orders });
});

// Liveness endpoint used by the Docker HEALTHCHECK.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

const server = app.listen(PORT, () => console.log(`api-gateway listening on port ${PORT}`));

// Docker sends SIGTERM on `docker stop`; finish in-flight requests then exit.
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
