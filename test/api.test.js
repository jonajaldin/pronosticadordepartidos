'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { boot } = require('../test-support/boot');
const { buildTwoSeasons } = require('../test-support/synthetic-league');
const { createLimiter, normalizeMatchesResponse } = require('../src/footballData');
const { ApiError } = require('../src/errors');

function league(options) {
  const data = buildTwoSeasons({ now: Date.now(), ...options });
  return {
    ...data,
    seasons: { current: data.current.body, [String(data.startYear - 1)]: data.previous.body },
  };
}

async function start(t, options = {}) {
  const app = await boot(options);
  t.after(() => app.close());
  return app;
}

const sum = (p) => p.home + p.draw + p.away;
const failWith = (status, body, headers = {}) => (req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
  return true;
};

// ---------------------------------------------------------------------------
// Camino feliz
// ---------------------------------------------------------------------------
test('/api/status informa el token y lista las competencias sin gastar consultas', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  const { status, body } = await app.get('/api/status');
  assert.equal(status, 200);
  assert.equal(body.tokenConfigured, true);
  assert.ok(body.competitions.some((c) => c.code === 'PD'));
  assert.equal(app.upstream.state.requests.length, 0);
});

test('/api/fixtures devuelve equipos, partido en vivo, próximos y pronóstico de cada uno', async (t) => {
  const data = league({ liveNow: true });
  const app = await start(t, { seasons: data.seasons });

  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 200);
  assert.equal(body.competition.code, 'PL');
  assert.equal(body.teams.length, 20);
  assert.deepEqual(body.teams.map((x) => x.shortName), [...body.teams.map((x) => x.shortName)].sort((a, b) => a.localeCompare(b, 'es')));

  assert.equal(body.live.length, 1);
  assert.equal(body.live[0].status, 'IN_PLAY');
  assert.deepEqual(body.live[0].score, { home: 1, away: 0 });

  assert.ok(body.upcoming.length > 0 && body.upcoming.length <= 10);
  const kickoffs = body.upcoming.map((m) => Date.parse(m.kickoff));
  assert.deepEqual(kickoffs, [...kickoffs].sort((a, b) => a - b));
  for (const m of [...body.live, ...body.upcoming]) {
    assert.ok(Math.abs(sum(m.prediction.probabilities) - 1) < 1e-3);
    assert.ok(['HOME', 'DRAW', 'AWAY'].includes(m.prediction.outcome));
  }

  assert.equal(body.meta.stale, false);
  assert.equal(body.meta.previousSeason, 'used');
  const requests = app.upstream.state.requests;
  assert.deepEqual(requests.map((r) => r.season), [null, String(data.startYear - 1)]);
  assert.ok(requests.every((r) => r.token === 'test-token'));
  assert.ok(!JSON.stringify(body).includes('test-token'), 'el token nunca viaja al navegador');
});

test('/api/predict acepta nombre, abreviatura, id, mayúsculas y tildes; el más fuerte es favorito', async (t) => {
  const data = league();
  const app = await start(t, { seasons: data.seasons });

  const rating = (id) => data.truth.attack.get(id) / data.truth.defense.get(id);
  const ranked = data.current.teams.map((x) => x).sort((a, b) => rating(b.id) - rating(a.id));
  const strong = ranked[0];
  const weak = ranked[ranked.length - 1];

  const home = await app.get(`/api/predict?competition=PL&home=${encodeURIComponent(strong.shortName)}&away=${weak.id}`);
  assert.equal(home.status, 200);
  assert.equal(home.body.home.id, strong.id);
  assert.equal(home.body.away.id, weak.id);
  assert.equal(home.body.prediction.outcome, 'HOME');
  assert.ok(Math.abs(sum(home.body.prediction.probabilities) - 1) < 1e-3);
  assert.ok(home.body.prediction.predictedScore.home > home.body.prediction.predictedScore.away);
  assert.equal(home.body.prediction.topScores.length, 5);
  assert.ok(home.body.prediction.expectedGoals.home > home.body.prediction.expectedGoals.away);
  assert.ok(home.body.basis.matches > 400);

  const reverse = await app.get(`/api/predict?competition=PL&home=${weak.id}&away=${strong.id}`);
  assert.ok(reverse.body.prediction.probabilities.away > reverse.body.prediction.probabilities.home);

  const loose = await app.get('/api/predict?competition=pl&home=ARS&away=chelsea');
  assert.equal(loose.status, 200);
  assert.equal(loose.body.home.shortName, 'Arsenal');
  assert.equal(loose.body.away.shortName, 'Chelsea');

  const accents = await app.get(`/api/predict?competition=PL&home=${encodeURIComponent('Nóttingham')}&away=Liverpool`);
  assert.equal(accents.status, 200);
  assert.equal(accents.body.home.shortName, 'Nottingham');
});

// ---------------------------------------------------------------------------
// Errores del usuario
// ---------------------------------------------------------------------------
test('/api/predict explica los errores de escritura con sugerencias', async (t) => {
  const app = await start(t, { seasons: league().seasons });

  const typo = await app.get('/api/predict?competition=PL&home=Arsenl&away=Chelsea');
  assert.equal(typo.status, 404);
  assert.equal(typo.body.error.code, 'team_not_found');
  assert.match(typo.body.error.hint, /Arsenal/);

  const ambiguous = await app.get('/api/predict?competition=PL&home=Manchester&away=Chelsea');
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.error.code, 'ambiguous_team');
  assert.match(ambiguous.body.error.message, /Man City/);
  assert.match(ambiguous.body.error.message, /Man United/);

  const leadingZero = await app.get('/api/predict?competition=PL&home=057&away=Chelsea');
  assert.equal(leadingZero.status, 404, '«057» no es el id 57: es texto');
  assert.equal(leadingZero.body.error.code, 'team_not_found');

  const same = await app.get('/api/predict?competition=PL&home=Arsenal&away=ARS');
  assert.equal(same.status, 400);
  assert.equal(same.body.error.code, 'same_team');

  const missing = await app.get('/api/predict?competition=PL&home=Arsenal');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'bad_request');
});

test('una competencia desconocida se rechaza sin consultar la API', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  const { status, body } = await app.get('/api/fixtures?competition=XX');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'unknown_competition');
  assert.equal(app.upstream.state.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Fallos de la API externa
// ---------------------------------------------------------------------------
test('sin token: 503 con instrucciones y sin llamar a la API', async (t) => {
  const app = await start(t, { seasons: league().seasons, clientToken: '' });

  const status = await app.get('/api/status');
  assert.equal(status.body.tokenConfigured, false);

  const { status: code, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(code, 503);
  assert.equal(body.error.code, 'missing_token');
  assert.match(body.error.hint, /football-data\.org\/client\/register/);
  assert.equal(app.upstream.state.requests.length, 0);
});

test('token inválido: 502 invalid_token con pista para corregir .env', async (t) => {
  const app = await start(t, { seasons: league().seasons, token: 'correcto', clientToken: 'equivocado' });
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 502);
  assert.equal(body.error.code, 'invalid_token');
  assert.match(body.error.hint, /\.env/);
  assert.equal(app.upstream.state.requests.length, 1, 'no reintenta un token inválido');
});

test('403 de un firewall o proxy (sin el JSON de la API): 502 blocked con el detalle', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  app.upstream.state.override = (req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Host not in allowlist: api.football-data.org. Add this host to your network egress settings.');
    return true;
  };
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 502);
  assert.equal(body.error.code, 'blocked');
  assert.match(body.error.message, /red bloque/);
  assert.match(body.error.hint, /Host not in allowlist/);

  app.upstream.state.override = (req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Acceso denegado</h1><p>Contacte al administrador</p></body></html>');
    return true;
  };
  const html = await app.get('/api/fixtures?competition=PD');
  assert.equal(html.body.error.code, 'blocked');
  assert.doesNotMatch(html.body.error.hint, /</, 'no deja etiquetas HTML en el mensaje');
});

test('competencia fuera del plan (403): 502 restricted', async (t) => {
  const app = await start(t, { seasons: {} });
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 502);
  assert.equal(body.error.code, 'restricted');
});

test('si el plan no da la temporada anterior, sigue con la actual y no vuelve a preguntar', async (t) => {
  const app = await start(t, { seasons: { current: league().current.body } });

  const first = await app.get('/api/fixtures?competition=PL');
  assert.equal(first.status, 200);
  assert.equal(first.body.meta.previousSeason, 'unavailable');
  assert.ok(first.body.upcoming.every((m) => m.prediction));

  const second = await app.get('/api/predict?competition=PL&home=Arsenal&away=Chelsea');
  assert.equal(second.status, 200);
  assert.equal(app.upstream.state.requests.length, 2, 'una vez la actual y una vez la anterior (rechazada)');
});

test('429 con Retry-After corto: espera y reintenta solo', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  let calls = 0;
  app.upstream.state.override = (req, res) => {
    calls += 1;
    return calls === 1
      ? failWith(429, { message: 'You reached your request limit. Wait 0 seconds.' }, { 'Retry-After': '0' })(req, res)
      : false;
  };
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 200);
  assert.equal(body.teams.length, 20);
  assert.ok(calls >= 2);
});

test('429 con espera larga: avisa con retryAfter en el cuerpo y en la cabecera', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  app.upstream.state.override = failWith(429, { message: 'Wait' }, { 'Retry-After': '45' });
  const { status, headers, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 429);
  assert.equal(body.error.code, 'rate_limited');
  assert.equal(body.error.retryAfter, 45);
  assert.equal(headers.get('retry-after'), '45');
  assert.equal(app.upstream.state.requests.length, 1, 'no se queda esperando 45 s');
});

test('429 sin cabecera: lee los segundos del mensaje', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  app.upstream.state.override = failWith(429, { message: 'You reached your request limit. Wait 32 seconds.' });
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 429);
  assert.equal(body.error.retryAfter, 32);
});

test('error 500 pasajero: reintenta y responde bien', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  let calls = 0;
  app.upstream.state.override = (req, res) => {
    calls += 1;
    return calls <= 2 ? failWith(500, { message: 'boom' })(req, res) : false;
  };
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 200);
  assert.equal(body.meta.stale, false);
});

test('error 500 permanente: 502 upstream_error tras reintentar', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  app.upstream.state.override = failWith(500, { message: 'boom' });
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 502);
  assert.equal(body.error.code, 'upstream_error');
  assert.equal(app.upstream.state.requests.length, 3, '1 intento + 2 reintentos');
});

test('respuesta que no es JSON (proxy/firewall): 502 bad_response', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  app.upstream.state.override = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>Inicia sesión en la red</html>');
    return true;
  };
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 502);
  assert.equal(body.error.code, 'bad_response');
});

test('JSON con formato inesperado: 502 bad_response', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  app.upstream.state.override = failWith(200, { data: [] });
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 502);
  assert.equal(body.error.code, 'bad_response');
});

test('la API no responde: 504 timeout', async (t) => {
  const app = await start(t, { seasons: league().seasons, clientOptions: { timeoutMs: 100, maxRetries: 0 } });
  app.upstream.state.override = () => undefined; // nunca contesta
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 504);
  assert.equal(body.error.code, 'timeout');
});

test('sin conexión: 502 network', async (t) => {
  // Un puerto que estuvo abierto y ahora está cerrado: la conexión se rechaza de inmediato.
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));

  const app = await start(t, {
    seasons: league().seasons,
    clientOptions: { baseUrl: `http://127.0.0.1:${port}/v4`, maxRetries: 1 },
  });
  const { status, body } = await app.get('/api/fixtures?competition=PL');
  assert.equal(status, 502);
  assert.equal(body.error.code, 'network');
  assert.match(body.error.hint, /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// Caché y datos guardados
// ---------------------------------------------------------------------------
test('la caché evita consultas repetidas y junta las simultáneas en una sola', async (t) => {
  const app = await start(t, { seasons: league().seasons });
  await Promise.all(Array.from({ length: 5 }, () => app.get('/api/fixtures?competition=PL')));
  await app.get('/api/predict?competition=PL&home=Arsenal&away=Chelsea');
  await app.get('/api/fixtures?competition=PL');
  assert.equal(app.upstream.state.requests.length, 2, 'temporada actual + anterior, una vez cada una');
});

test('si la API falla después de haber respondido, muestra los datos guardados y lo avisa', async (t) => {
  const clock = { t: Date.now() };
  const app = await start(t, {
    seasons: league().seasons,
    clientOptions: { now: () => clock.t },
    serviceOptions: { now: () => clock.t },
  });

  const fresh = await app.get('/api/fixtures?competition=PL');
  assert.equal(fresh.body.meta.stale, false);

  clock.t += 10 * 60_000;
  app.upstream.state.override = failWith(500, { message: 'boom' });
  const stale = await app.get('/api/fixtures?competition=PL');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.meta.stale, true);
  assert.equal(stale.body.meta.staleReason.code, 'upstream_error');
  assert.equal(stale.body.teams.length, 20);

  const predicted = await app.get('/api/predict?competition=PL&home=Arsenal&away=Chelsea');
  assert.equal(predicted.status, 200);
  assert.equal(predicted.body.meta.stale, true);

  app.upstream.state.override = null;
  clock.t += 10 * 60_000;
  const recovered = await app.get('/api/fixtures?competition=PL');
  assert.equal(recovered.body.meta.stale, false);
});

test('el limitador espera su turno y falla si tardaría demasiado', async () => {
  let t = 0;
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    t += ms;
  };

  const patient = createLimiter({ limit: 2, windowMs: 60_000, now: () => t, sleep });
  await patient();
  await patient();
  await patient(120_000);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 60_000 && sleeps[0] < 60_100);

  const strict = createLimiter({ limit: 1, windowMs: 60_000, now: () => t, sleep });
  await strict();
  await assert.rejects(
    () => strict(),
    (err) => err instanceof ApiError && err.code === 'rate_limited' && err.status === 429 && err.retryAfter >= 60,
  );
});

// ---------------------------------------------------------------------------
// Normalización de datos
// ---------------------------------------------------------------------------
test('ignora partidos con equipos por definir o fecha inválida y lee la temporada', () => {
  const team = (id) => ({ id, name: `Equipo ${id}`, shortName: `E${id}`, tla: `E${id}`, crest: 'https://x/c.png' });
  const season = { startDate: '2026-01-28', endDate: '2026-12-06' };
  const parsed = normalizeMatchesResponse({
    competition: { code: 'BSA', name: 'Campeonato Brasileiro Série A', emblem: 'http://inseguro/e.png' },
    matches: [
      { id: 1, utcDate: '2026-03-01T20:00:00Z', status: 'FINISHED', season, homeTeam: team(1), awayTeam: team(2), score: { fullTime: { home: 2, away: 1 } } },
      { id: 2, utcDate: '2026-12-01T20:00:00Z', status: 'TIMED', season, homeTeam: { id: null, name: null }, awayTeam: team(2), score: { fullTime: {} } },
      { id: 3, utcDate: 'no-es-fecha', status: 'TIMED', season, homeTeam: team(1), awayTeam: team(2), score: {} },
    ],
  });
  assert.equal(parsed.matches.length, 1);
  assert.equal(parsed.skipped, 2);
  assert.deepEqual(parsed.season, { startYear: 2026, endYear: 2026, label: '2026' });
  assert.equal(parsed.competition.emblem, null, 'solo se aceptan imágenes https');
  assert.deepEqual(parsed.matches[0].score, { home: 2, away: 1 });

  const empty = normalizeMatchesResponse({ filters: { season: '2025' }, matches: [] });
  assert.deepEqual(empty.season, { startYear: 2025, endYear: 2025, label: '2025' });
});

// ---------------------------------------------------------------------------
// Servidor de archivos y seguridad
// ---------------------------------------------------------------------------
test('sirve la interfaz con cabeceras de seguridad y no deja salir de /public', async (t) => {
  const app = await start(t, { seasons: league().seasons });

  const page = await app.get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.body, /<title>Pronosticador/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

  assert.match((await app.get('/styles.css')).headers.get('content-type'), /text\/css/);
  assert.match((await app.get('/app.js')).headers.get('content-type'), /text\/javascript/);
  assert.match((await app.get('/favicon.svg')).headers.get('content-type'), /image\/svg\+xml/);

  assert.equal((await app.get('/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await app.get('/%2e%2e%2fserver.js')).status, 404);
  assert.equal((await app.get('/%E0%A4%A')).status, 404);
  assert.equal((await app.get('/nope.txt')).status, 404);
  assert.equal((await app.get('/src/')).status, 404);
  assert.equal(app.upstream.state.requests.length, 0);
});

test('rutas de API desconocidas y métodos no permitidos responden JSON claro', async (t) => {
  const app = await start(t, { seasons: league().seasons });

  const unknown = await app.get('/api/nada');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'not_found');

  const post = await app.get('/api/status', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});
