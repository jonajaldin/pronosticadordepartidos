'use strict';

// Cliente de football-data.org (v4). Un solo endpoint alimenta toda la app:
//   GET /competitions/{code}/matches[?season=YYYY]  -> todos los partidos de la temporada
// Incluye: token por cabecera, timeout, reintentos con espera, límite de consultas
// del plan gratuito, caché en memoria (con datos viejos si la API falla) y errores claros.

const { ApiError } = require('./errors');
const { REGISTER_URL } = require('./config');

const LIVE_STATUSES = new Set(['IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT', 'LIVE']);
const UPCOMING_STATUSES = new Set(['SCHEDULED', 'TIMED']);

const isLive = (match) => LIVE_STATUSES.has(match.status);
const isUpcoming = (match) => UPCOMING_STATUSES.has(match.status);
const isFinished = (match) =>
  match.status === 'FINISHED' && match.score.home !== null && match.score.away !== null;

const LIVE_TTL_MS = 60_000;
const IDLE_TTL_MS = 5 * 60_000;
const HISTORY_TTL_MS = 12 * 60 * 60_000;
const LIMITER_MAX_WAIT_MS = 20_000;
const MAX_RETRY_AFTER_S = 15;
const USER_AGENT = 'pronosticador-de-partidos/1.0';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Límite de consultas (ventana deslizante). Espera su turno; si tardaría demasiado, falla.
// ---------------------------------------------------------------------------
function createLimiter({ limit, windowMs, now = Date.now, sleep = defaultSleep }) {
  const stamps = [];
  return async function acquire(maxWaitMs = LIMITER_MAX_WAIT_MS) {
    const started = now();
    for (;;) {
      const t = now();
      while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length < limit) {
        stamps.push(t);
        return;
      }
      const wait = windowMs - (t - stamps[0]) + 25;
      if (t - started + wait > maxWaitMs) {
        const retryAfter = Math.ceil(wait / 1000);
        throw new ApiError('rate_limited', 'Demasiadas consultas seguidas al plan gratuito.', {
          status: 429,
          retryAfter,
          hint: `Reintenta en ${retryAfter} s.`,
        });
      }
      await sleep(wait);
    }
  };
}

// ---------------------------------------------------------------------------
// Traducción de fallos a errores nuestros
// ---------------------------------------------------------------------------
function networkError(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new ApiError('timeout', 'football-data.org tardó demasiado en responder.', {
      status: 504,
      cause: err,
      hint: 'Reintenta en unos segundos.',
    });
  }
  const cause = err && err.cause;
  const detail = (err && err.code) || (cause && (cause.code || cause.message)) || '';
  return new ApiError('network', 'No se pudo conectar con football-data.org.', {
    status: 502,
    cause: err,
    hint: `Revisa tu conexión a internet o el firewall${detail ? ` (${detail})` : ''}.`,
  });
}

function retryAfterSeconds(headers, message) {
  const fromHeader = Number.parseInt(headers.get('retry-after') ?? headers.get('x-requestcounter-reset'), 10);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  const fromMessage = /(\d+)\s*seconds?/i.exec(message);
  return fromMessage ? Number.parseInt(fromMessage[1], 10) : null;
}

function httpError(status, bodyText, headers) {
  let upstream = '';
  let fromApi = false; // la API de football-data.org siempre responde JSON con { message, errorCode }
  try {
    const parsed = JSON.parse(bodyText);
    upstream = String((parsed && parsed.message) || '');
    fromApi = Boolean(parsed) && typeof parsed === 'object' && ('message' in parsed || 'errorCode' in parsed);
  } catch {
    // el cuerpo no era JSON
  }

  // 401/403/407/451 sin el JSON de la API: lo dijo un firewall, proxy o portal, no football-data.org.
  if ([401, 403, 407, 451].includes(status) && !fromApi) {
    const detail = String(bodyText).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return new ApiError('blocked', 'Tu red bloqueó la conexión con football-data.org.', {
      hint: detail ? `Detalle: «${detail}»` : 'Revisa tu firewall, antivirus o proxy.',
    });
  }

  if (status === 429) {
    const retryAfter = retryAfterSeconds(headers, upstream) ?? 60;
    return new ApiError('rate_limited', 'Llegaste al límite del plan gratuito (10 consultas por minuto).', {
      status: 429,
      retryAfter,
      hint: `Reintenta en ${retryAfter} s. La app guarda resultados en memoria para gastar menos consultas.`,
    });
  }
  if (status === 401 || (status === 400 && /token/i.test(upstream))) {
    return new ApiError('invalid_token', 'football-data.org rechazó tu token.', {
      hint: `Revisa FOOTBALL_DATA_TOKEN en el archivo .env (sin comillas ni espacios). Puedes pedir uno en ${REGISTER_URL}`,
    });
  }
  if (status === 403) {
    return new ApiError('restricted', 'Tu plan gratuito no incluye este recurso.', {
      hint: upstream || 'Confirma tu correo en football-data.org y revisa que la competencia esté en el plan gratuito.',
    });
  }
  if (status === 404) {
    return new ApiError('not_found', 'football-data.org no encontró el recurso pedido.', { status: 404, hint: upstream || null });
  }
  if (status >= 500) {
    return new ApiError('upstream_error', 'football-data.org tiene problemas en este momento.', {
      hint: `Respondió ${status}. Reintenta en un minuto.`,
    });
  }
  return new ApiError('bad_request', `football-data.org rechazó la consulta (${status}).`, { hint: upstream || null });
}

// ---------------------------------------------------------------------------
// Normalización: nos quedamos solo con lo que usa la app y descartamos lo raro
// ---------------------------------------------------------------------------
const httpsOrNull = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : null);
const goals = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function normalizeTeam(raw) {
  if (!raw || raw.id == null || raw.id === '') return null; // equipos por definir (eliminatorias)
  const id = Number(raw.id);
  if (!Number.isInteger(id)) return null;
  const name = String(raw.name || raw.shortName || raw.tla || id);
  return {
    id,
    name,
    shortName: String(raw.shortName || name),
    tla: raw.tla ? String(raw.tla) : null,
    crest: httpsOrNull(raw.crest),
  };
}

function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const home = normalizeTeam(raw.homeTeam);
  const away = normalizeTeam(raw.awayTeam);
  const timestamp = Date.parse(raw.utcDate);
  if (!home || !away || Number.isNaN(timestamp)) return null;
  const fullTime = (raw.score && raw.score.fullTime) || {};
  return {
    id: raw.id ?? null,
    kickoff: new Date(timestamp).toISOString(),
    timestamp,
    status: String(raw.status || 'UNKNOWN'),
    matchday: Number.isInteger(raw.matchday) ? raw.matchday : null,
    home,
    away,
    score: { home: goals(fullTime.home), away: goals(fullTime.away) },
  };
}

function normalizeSeason(body) {
  const withSeason = body.matches.find((m) => m && m.season && typeof m.season.startDate === 'string');
  const start = withSeason ? withSeason.season.startDate : null;
  const end = withSeason && typeof withSeason.season.endDate === 'string' ? withSeason.season.endDate : null;
  const fromFilter = Number.parseInt(body.filters && body.filters.season, 10);
  let startYear = Number.isFinite(fromFilter) ? fromFilter : null;
  if (start && Number.isFinite(Number.parseInt(start.slice(0, 4), 10))) startYear = Number.parseInt(start.slice(0, 4), 10);
  const endYear = end && Number.isFinite(Number.parseInt(end.slice(0, 4), 10)) ? Number.parseInt(end.slice(0, 4), 10) : startYear;
  let label = null;
  if (startYear != null) label = endYear && endYear !== startYear ? `${startYear}/${String(endYear).slice(2)}` : String(startYear);
  return { startYear, endYear, label };
}

function normalizeMatchesResponse(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.matches)) {
    throw new ApiError('bad_response', 'football-data.org respondió con un formato inesperado.', {
      hint: 'Ejecuta `npm run check` para ver el detalle.',
    });
  }
  const matches = [];
  let skipped = 0;
  for (const raw of body.matches) {
    const match = normalizeMatch(raw);
    if (match) matches.push(match);
    else skipped += 1;
  }
  const competition = body.competition && typeof body.competition === 'object' ? body.competition : {};
  return {
    competition: {
      code: competition.code ? String(competition.code) : null,
      name: competition.name ? String(competition.name) : null,
      emblem: httpsOrNull(competition.emblem),
    },
    season: normalizeSeason(body),
    matches,
    skipped,
  };
}

// ¿Conviene refrescar pronto? (hay partido en juego, por empezar o con estado atrasado)
function hasLiveWindow(matches, t) {
  return matches.some(
    (m) => isLive(m) || (isUpcoming(m) && m.timestamp - t < 15 * 60_000 && t - m.timestamp < 3 * 3_600_000),
  );
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------
function createClient({
  token,
  baseUrl = 'https://api.football-data.org/v4',
  timeoutMs = 10_000,
  requestsPerMinute = 10,
  maxRetries = 2,
  retryDelayMs = 500,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  const acquire = createLimiter({ limit: requestsPerMinute, windowMs: 60_000, now, sleep });
  const cache = new Map();
  const inflight = new Map();

  async function readJson(res) {
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw networkError(err);
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new ApiError('bad_response', 'football-data.org devolvió algo que no es JSON.', {
        cause,
        hint: 'Suele pasar cuando un proxy o firewall intercepta la conexión.',
      });
    }
  }

  async function requestJson(path) {
    if (!token) {
      throw new ApiError('missing_token', 'Falta el token gratuito de football-data.org.', {
        status: 503,
        hint: `Regístrate en ${REGISTER_URL}, pega el token en .env (FOOTBALL_DATA_TOKEN=...) y reinicia con npm start.`,
      });
    }
    const url = `${baseUrl}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      await acquire();

      let res;
      try {
        res = await fetchImpl(url, {
          headers: { 'X-Auth-Token': token, Accept: 'application/json', 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw networkError(err);
      }

      if (res.ok) return readJson(res);

      const failure = httpError(res.status, await res.text().catch(() => ''), res.headers);
      const canRetry = attempt < maxRetries;
      if (failure.code === 'rate_limited' && canRetry && failure.retryAfter <= MAX_RETRY_AFTER_S) {
        await sleep(failure.retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && canRetry) {
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      throw failure;
    }
  }

  // Caché con: datos vigentes, una sola consulta si llegan varias a la vez,
  // y datos vencidos (marcados `stale`) si la API falla.
  function cached(key, ttlFor, loader) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) {
      return Promise.resolve({ data: hit.data, fetchedAt: hit.fetchedAt, stale: false });
    }
    if (inflight.has(key)) return inflight.get(key);

    const job = loader()
      .then((data) => {
        const fetchedAt = now();
        cache.set(key, { data, fetchedAt, expiresAt: fetchedAt + ttlFor(data) });
        return { data, fetchedAt, stale: false };
      })
      .catch((err) => {
        if (hit) return { data: hit.data, fetchedAt: hit.fetchedAt, stale: true, staleReason: err };
        throw err;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  // Todos los partidos de una competencia (temporada actual, o la pedida con { season: 2025 }).
  function getMatches(code, { season } = {}) {
    const query = season ? `?season=${encodeURIComponent(season)}` : '';
    return cached(
      `matches:${code}:${season || 'current'}`,
      (data) => (season ? HISTORY_TTL_MS : hasLiveWindow(data.matches, now()) ? LIVE_TTL_MS : IDLE_TTL_MS),
      async () =>
        normalizeMatchesResponse(await requestJson(`/competitions/${encodeURIComponent(code)}/matches${query}`)),
    );
  }

  return { getMatches, hasToken: Boolean(token) };
}

module.exports = {
  createClient,
  createLimiter,
  normalizeMatchesResponse,
  isLive,
  isUpcoming,
  isFinished,
};
