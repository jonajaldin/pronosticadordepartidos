'use strict';

// Servidor que imita a football-data.org: token por cabecera + /v4/competitions/{code}/matches[?season=].
// `state.override(req, res, url)` permite simular fallos (429, 500, HTML, silencio...):
// si devuelve false, la petición sigue con el comportamiento normal.

const http = require('node:http');

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8', ...headers });
  res.end(JSON.stringify(body));
}

async function startMockUpstream({ token = 'test-token', seasons = {} } = {}) {
  const state = { requests: [], override: null, seasons };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    state.requests.push({
      path: url.pathname,
      season: url.searchParams.get('season'),
      token: req.headers['x-auth-token'],
    });
    if (state.override && state.override(req, res, url) !== false) return undefined;

    if (req.headers['x-auth-token'] !== token) {
      return json(res, 400, { message: 'Your API token is invalid.', errorCode: 400 });
    }
    const match = url.pathname.match(/^\/v4\/competitions\/([A-Z0-9]+)\/matches$/);
    if (!match) return json(res, 404, { message: 'The resource you are looking for does not exist.', errorCode: 404 });

    const body = state.seasons[url.searchParams.get('season') || 'current'];
    if (!body) {
      return json(res, 403, {
        message:
          'The resource you are looking for is restricted and apparently not within your permissions. Please check your subscription.',
        errorCode: 403,
      });
    }
    return json(res, 200, body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v4`,
    state,
    json,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

module.exports = { startMockUpstream, json };
