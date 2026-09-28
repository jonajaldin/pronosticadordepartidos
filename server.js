'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');

const { ROOT, REGISTER_URL, loadEnvFile, readConfig, saveToken } = require('./src/config');
const { createClient } = require('./src/footballData');
const { createService } = require('./src/service');
const { ApiError } = require('./src/errors');

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MAX_PARAM_LENGTH = 80;

function createApp({ config, service, publicDir = PUBLIC_DIR }) {
  const root = path.resolve(publicDir);

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  const sendError = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

  const param = (url, name) => (url.searchParams.get(name) || '').trim().slice(0, MAX_PARAM_LENGTH);

  async function handleApi(url, res) {
    try {
      switch (url.pathname) {
        case '/api/status':
          return sendJson(res, 200, {
            tokenConfigured: Boolean(config.token),
            provider: 'football-data.org',
            competitions: service.competitions,
          });
        case '/api/competitions':
          return sendJson(res, 200, { competitions: service.competitions });
        case '/api/fixtures':
          return sendJson(res, 200, await service.getFixtures(param(url, 'competition').toUpperCase()));
        case '/api/predict':
          return sendJson(
            res,
            200,
            await service.predict(param(url, 'competition').toUpperCase(), param(url, 'home'), param(url, 'away')),
          );
        default:
          return sendError(res, 404, 'not_found', 'Ruta desconocida.');
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.retryAfter != null) res.setHeader('Retry-After', String(err.retryAfter));
      return sendJson(res, err.status, { error: err.toJSON() });
    }
  }

  async function serveStatic(pathname, res) {
    const notFound = () => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
    };
    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return notFound();
    }
    if (relative.endsWith('/')) relative += 'index.html';
    const file = path.join(root, relative);
    if (!file.startsWith(root + path.sep)) return notFound();
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      return res.end(body);
    } catch {
      return notFound();
    }
  }

  async function handle(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendError(res, 405, 'method_not_allowed', 'Método no permitido.');
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendError(res, 400, 'bad_request', 'Dirección inválida.');
    }
    return url.pathname.startsWith('/api/') ? handleApi(url, res) : serveStatic(url.pathname, res);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('Error inesperado:', err);
      if (res.headersSent) return res.end();
      return sendError(res, 500, 'internal', 'Error interno de la aplicación.');
    });
  });
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function askForToken() {
  console.log('\nFalta tu token gratuito de football-data.org (te llega por correo al registrarte):');
  console.log(`  ${REGISTER_URL}\n`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('Guárdalo en el archivo .env como FOOTBALL_DATA_TOKEN=... y ejecuta npm start otra vez.\n');
    return '';
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
    process.exit(130);
  });
  const answer = await rl.question('Pega tu token y presiona Enter (Enter vacío = continuar sin token): ');
  rl.close();
  const token = answer.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (token) {
    try {
      saveToken(token);
      console.log('Token guardado en .env\n');
    } catch (err) {
      console.log(`No pude guardar .env (${err.code || err.message}); se usará solo esta vez.\n`);
    }
  }
  return token;
}

async function prewarm(service, config) {
  if (!config.token) {
    console.log('AVISO: sin token. La página mostrará cómo obtenerlo.');
    return;
  }
  try {
    const data = await service.getFixtures(service.competitions[0].code);
    console.log(
      `OK: conexión con football-data.org (${data.competition.name}: ${data.teams.length} equipos, ${data.upcoming.length} próximos partidos)`,
    );
  } catch (err) {
    console.log(`ERROR: ${err.message}${err.hint ? `\n  -> ${err.hint}` : ''}`);
  }
}

async function main() {
  loadEnvFile();
  const config = readConfig();
  if (!config.token) config.token = await askForToken();

  const service = createService({ client: createClient(config) });
  const server = createApp({ config, service });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`El puerto ${config.port} ya está en uso. Cierra la otra copia o agrega PORT=3001 al archivo .env`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(config.port, config.host, () => {
    const shown = config.host === '127.0.0.1' || config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`\nPronosticador de Partidos listo -> http://${shown}:${config.port}\n`);
    prewarm(service, config);
  });

  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { createApp };
