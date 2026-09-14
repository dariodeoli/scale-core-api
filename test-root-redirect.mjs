import assert from 'node:assert/strict';
import http from 'node:http';

process.env.SCALE_CORE_API_DISABLE_LISTEN = '1';
const { server } = await import('./server.js');

assert.equal(server.listening, false, 'importing with SCALE_CORE_API_DISABLE_LISTEN=1 must not start a listener');

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const { port } = server.address();
  const response = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/' }, resolve);
    request.once('error', reject);
  });

  assert.equal(response.statusCode, 307);
  assert.equal(response.headers.location, 'https://app.scaleparaguay.com/superadmin');
  response.resume();
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
