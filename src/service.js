'use strict';

const { ApiError } = require('./errors');
const { isFinished, isLive, isUpcoming } = require('./footballData');
const predictor = require('./predictor');

// Competencias del plan gratuito de football-data.org que tienen tabla única (ligas y Champions).
const COMPETITIONS = Object.freeze([
  { code: 'PD', name: 'LaLiga', country: 'España' },
  { code: 'CL', name: 'UEFA Champions League', country: 'Europa' },
  { code: 'PL', name: 'Premier League', country: 'Inglaterra' },
  { code: 'SA', name: 'Serie A', country: 'Italia' },
  { code: 'BL1', name: 'Bundesliga', country: 'Alemania' },
  { code: 'FL1', name: 'Ligue 1', country: 'Francia' },
  { code: 'BSA', name: 'Brasileirão Série A', country: 'Brasil' },
  { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  { code: 'DED', name: 'Eredivisie', country: 'Países Bajos' },
  { code: 'ELC', name: 'Championship', country: 'Inglaterra' },
]);
const BY_CODE = new Map(COMPETITIONS.map((c) => [c.code, c]));

const DEFAULT_FIXTURES = 10;
const STALE_STATUS_MS = 6 * 3_600_000; // un "programado" con 6 h de atraso es un dato viejo, no un partido próximo
const PERMANENT_ERRORS = new Set(['restricted', 'not_found', 'bad_request']);
const PERMANENT_BLOCK_MS = 6 * 3_600_000;
const TRANSIENT_BLOCK_MS = 60_000;

const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

// ---------------------------------------------------------------------------
// Nombres de equipos: acepta id, nombre, abreviatura o parte del nombre (sin tildes)
// ---------------------------------------------------------------------------
const normalizeText = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function suggest(query, teams) {
  const limit = Math.max(2, Math.floor(query.length / 3));
  return teams
    .map((team) => ({
      team,
      d: Math.min(distance(query, normalizeText(team.name)), distance(query, normalizeText(team.shortName))),
    }))
    .filter((s) => s.d <= limit)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((s) => s.team.shortName);
}

function resolveTeam(teams, ref, role) {
  const raw = String(ref ?? '').trim();
  if (!raw) throw new ApiError('bad_request', `Falta el equipo ${role}.`, { status: 400 });

  // Un número sin ceros a la izquierda es un id; "05" (como en "Mainz 05") es parte de un nombre.
  if (/^[1-9]\d*$/.test(raw) && teams.has(Number(raw))) return teams.get(Number(raw));

  const list = [...teams.values()];
  const query = normalizeText(raw);
  const fields = (team) => [team.name, team.shortName, team.tla].filter(Boolean).map(normalizeText);
  const tiers = [
    (field) => field === query,
    (field) => field.startsWith(query),
    (field) => query.split(' ').every((token) => field.includes(token)),
  ];
  if (query) {
    for (const matches of tiers) {
      const found = list.filter((team) => fields(team).some(matches));
      if (found.length === 1) return found[0];
      if (found.length > 1) {
        throw new ApiError(
          'ambiguous_team',
          `«${raw}» coincide con varios equipos: ${found.map((t) => t.shortName).join(', ')}.`,
          { status: 400, hint: 'Escribe el nombre completo.' },
        );
      }
    }
  }
  const options = query ? suggest(query, list) : [];
  throw new ApiError('team_not_found', `No encontré «${raw}» (${role}) en esta competencia.`, {
    status: 404,
    hint: options.length ? `¿Quisiste decir: ${options.join(', ')}?` : 'Elige un equipo de la lista o cambia de liga.',
  });
}

// ---------------------------------------------------------------------------
// Presentación (lo que viaja al navegador)
// ---------------------------------------------------------------------------
function presentPrediction(pred, { full = false } = {}) {
  const out = {
    outcome: pred.outcome,
    probabilities: {
      home: round(pred.probabilities.home),
      draw: round(pred.probabilities.draw),
      away: round(pred.probabilities.away),
    },
    expectedGoals: { home: round(pred.expectedGoals.home, 2), away: round(pred.expectedGoals.away, 2) },
    predictedScore: {
      home: pred.predictedScore.home,
      away: pred.predictedScore.away,
      probability: round(pred.predictedScore.probability),
    },
  };
  if (full) {
    out.topScores = pred.topScores.map((s) => ({ home: s.home, away: s.away, probability: round(s.probability) }));
  }
  return out;
}

function presentMatch(match, model) {
  return {
    id: match.id,
    kickoff: match.kickoff,
    status: match.status,
    matchday: match.matchday,
    home: match.home,
    away: match.away,
    score: match.score,
    prediction: model ? presentPrediction(predictor.predictMatch(model, match.home.id, match.away.id)) : null,
  };
}

function metaOf(data) {
  const meta = {
    fetchedAt: new Date(data.current.fetchedAt).toISOString(),
    stale: data.current.stale,
    previousSeason: data.previousState,
  };
  if (data.current.stale && data.current.staleReason) {
    const reason = data.current.staleReason;
    meta.staleReason = typeof reason.toJSON === 'function' ? reason.toJSON() : { code: 'unknown', message: String(reason.message) };
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------
function createService({ client, now = Date.now }) {
  const previousBlockedUntil = new Map();
  const modelMemo = new Map();

  // Temporada actual + anterior (si el plan la permite): la anterior rescata el inicio de temporada.
  async function loadCompetition(code) {
    const info = BY_CODE.get(code);
    if (!info) {
      throw new ApiError('unknown_competition', `No conozco la competencia «${code}».`, {
        status: 404,
        hint: `Disponibles: ${COMPETITIONS.map((c) => c.code).join(', ')}.`,
      });
    }

    const current = await client.getMatches(code);
    const { startYear } = current.data.season;

    let previous = null;
    let previousState = 'none';
    if (startYear != null) {
      previousState = 'unavailable';
      if ((previousBlockedUntil.get(code) || 0) <= now()) {
        try {
          previous = await client.getMatches(code, { season: startYear - 1 });
          previousState = 'used';
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          previousBlockedUntil.set(code, now() + (PERMANENT_ERRORS.has(err.code) ? PERMANENT_BLOCK_MS : TRANSIENT_BLOCK_MS));
        }
      }
    }

    const key = `${current.fetchedAt}|${previous ? previous.fetchedAt : 0}`;
    let memo = modelMemo.get(code);
    if (!memo || memo.key !== key) {
      const finished = [...(previous ? previous.data.matches : []), ...current.data.matches].filter(isFinished);
      memo = { key, model: predictor.fitModel(finished, { now: now() }) };
      modelMemo.set(code, memo);
    }

    const teams = new Map();
    for (const match of current.data.matches) {
      teams.set(match.home.id, match.home);
      teams.set(match.away.id, match.away);
    }
    return { info, current, previousState, model: memo.model, teams };
  }

  async function getFixtures(code, { limit = DEFAULT_FIXTURES } = {}) {
    const data = await loadCompetition(code);
    const { matches, season } = data.current.data;
    const t = now();
    const byKickoff = (a, b) => a.timestamp - b.timestamp || (a.id ?? 0) - (b.id ?? 0);
    return {
      competition: data.info,
      season,
      teams: [...data.teams.values()].sort((a, b) => a.shortName.localeCompare(b.shortName, 'es')),
      live: matches.filter(isLive).sort(byKickoff).map((m) => presentMatch(m, data.model)),
      upcoming: matches
        .filter((m) => isUpcoming(m) && m.timestamp > t - STALE_STATUS_MS)
        .sort(byKickoff)
        .slice(0, limit)
        .map((m) => presentMatch(m, data.model)),
      meta: metaOf(data),
    };
  }

  async function predict(code, homeRef, awayRef) {
    const data = await loadCompetition(code);
    if (data.teams.size === 0) {
      throw new ApiError('no_data', 'Esta competencia todavía no tiene partidos cargados.', { status: 422 });
    }
    const home = resolveTeam(data.teams, homeRef, 'local');
    const away = resolveTeam(data.teams, awayRef, 'visitante');
    if (home.id === away.id) throw new ApiError('same_team', 'Elige dos equipos distintos.', { status: 400 });
    if (!data.model) {
      throw new ApiError('insufficient_data', 'Todavía no hay partidos jugados para calcular el pronóstico.', {
        status: 422,
        hint: 'Vuelve cuando se juegue la primera fecha.',
      });
    }

    const pred = predictor.predictMatch(data.model, home.id, away.id);
    return {
      competition: data.info,
      home,
      away,
      prediction: presentPrediction(pred, { full: true }),
      basis: {
        matches: data.model.matches,
        season: data.current.data.season.label,
        previousSeason: data.previousState,
        homeMatches: round(pred.homeMatches, 1),
        awayMatches: round(pred.awayMatches, 1),
      },
      meta: metaOf(data),
    };
  }

  return { competitions: COMPETITIONS, getFixtures, predict };
}

module.exports = { createService, COMPETITIONS };
