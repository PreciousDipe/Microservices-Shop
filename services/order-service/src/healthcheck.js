// Run by Docker's HEALTHCHECK. Uses Node's built-in http module so the
// runtime image does not need curl or wget installed.
const http = require('http');

const port = Number(process.env.PORT);

const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 3000 }, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
