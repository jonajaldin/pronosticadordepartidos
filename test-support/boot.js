'use strict';

// Levanta todo el sistema (API falsa + cliente + servicio + servidor HTTP) en puertos libres.

const { startMockUpstream } = require('./mock-upstream');
const { createClient } = require('../src/footballData');
const { createService } = require('../src/service');
const { createApp } = require('../server');

async function boot({ seasons, token = 'test-token', clientToken = token, clientOptions = {}, serviceOptions = {} } = {}) {
  const upstream = await startMockUpstream({ token, seasons });
  const client = createClient({
    token: clientToken,
    baseUrl: upstream.url,
    retryDelayMs: 1,
    requestsPerMinute: 1000,
    timeoutMs: 1000,
    ...clientOptions,
  });
  const service = createService({ client, ...serviceOptions });
  const app = createApp({ config: { token: clientToken }, service });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;

  async function get(path, init) {
    const res = await fetch(base + path, init);
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      // texto plano o HTML
    }
    return { status: res.status, headers: res.headers, body };
  }

  return {
    base,
    get,
    upstream,
    async close() {
      await upstream.close();
      await new Promise((resolve) => {
        app.closeAllConnections?.();
        app.close(resolve);
      });
    },
  };
}

module.exports = { boot };
