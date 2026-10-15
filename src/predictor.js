'use strict';

// Modelo de goles con fuerza de ataque y defensa por equipo (estilo Dixon-Coles):
//   goles del local     ~ Poisson( muLocal  × ataque(local)  × defensa(visitante) )
//   goles del visitante ~ Poisson( muVisita × ataque(visita) × defensa(local) )
// Los partidos recientes pesan más y los equipos con pocos partidos se acercan al promedio.

const MAX_GOALS = 10;
const RHO = -0.1; // corrección de marcadores bajos (0-0, 1-0, 0-1, 1-1)
const HALF_LIFE_DAYS = 300; // un partido de hace 300 días pesa la mitad
const PRIOR_GOALS = 6; // "goles de duda" que acercan a cada equipo al promedio de la liga
const MU_PRIOR_MATCHES = 8; // partidos "de duda" para los promedios de la liga...
const MU_PRIOR_HOME = 1.5; // ...con estos goles típicos de un local
const MU_PRIOR_AWAY = 1.2; // ...y de un visitante
const ITERATIONS = 60;
const MIN_LAMBDA = 0.05;
const MAX_LAMBDA = 6;
const DAY_MS = 86_400_000;
const NEUTRAL = Object.freeze({ attack: 1, defense: 1, weight: 0 });

// matches: partidos ya terminados, normalizados por footballData.js
// ({ home:{id}, away:{id}, score:{home,away}, timestamp }). Devuelve null si no hay ninguno.
function fitModel(
  matches,
  { now = Date.now(), halfLifeDays = HALF_LIFE_DAYS, priorGoals = PRIOR_GOALS, iterations = ITERATIONS } = {},
) {
  if (matches.length === 0) return null;

  const teams = new Map();
  const teamOf = (id) => {
    let team = teams.get(id);
    if (!team) {
      team = { attack: 1, defense: 1, weight: 0, scored: 0, expected: 0 };
      teams.set(id, team);
    }
    return team;
  };

  let totalWeight = 0;
  let sumHome = 0;
  let sumAway = 0;
  const rows = matches.map((m) => {
    const row = {
      h: teamOf(m.home.id),
      a: teamOf(m.away.id),
      homeGoals: m.score.home,
      awayGoals: m.score.away,
      w: 0.5 ** (Math.max(0, now - m.timestamp) / DAY_MS / halfLifeDays),
    };
    row.h.weight += row.w;
    row.a.weight += row.w;
    totalWeight += row.w;
    sumHome += row.w * row.homeGoals;
    sumAway += row.w * row.awayGoals;
    return row;
  });

  let muHome = (sumHome + MU_PRIOR_MATCHES * MU_PRIOR_HOME) / (totalWeight + MU_PRIOR_MATCHES);
  let muAway = (sumAway + MU_PRIOR_MATCHES * MU_PRIOR_AWAY) / (totalWeight + MU_PRIOR_MATCHES);
  const list = [...teams.values()];

  // Promedio ponderado = 1 para que ataque y defensa sean comparables entre equipos.
  const rescale = (key) => {
    let sw = 0;
    let sv = 0;
    for (const t of list) {
      sw += t.weight;
      sv += t.weight * t[key];
    }
    const mean = sv / sw;
    for (const t of list) t[key] /= mean;
    muHome *= mean;
    muAway *= mean;
  };
  const resetTotals = () => {
    for (const t of list) {
      t.scored = 0;
      t.expected = 0;
    }
  };

  for (let i = 0; i < iterations; i += 1) {
    // Ataque = goles marcados / goles esperados si el ataque fuera promedio.
    resetTotals();
    for (const r of rows) {
      r.h.scored += r.w * r.homeGoals;
      r.h.expected += r.w * muHome * r.a.defense;
      r.a.scored += r.w * r.awayGoals;
      r.a.expected += r.w * muAway * r.h.defense;
    }
    for (const t of list) t.attack = (t.scored + priorGoals) / (t.expected + priorGoals);
    rescale('attack');

    // Defensa = goles recibidos / goles esperados si la defensa fuera promedio.
    resetTotals();
    for (const r of rows) {
      r.h.scored += r.w * r.awayGoals;
      r.h.expected += r.w * muAway * r.a.attack;
      r.a.scored += r.w * r.homeGoals;
      r.a.expected += r.w * muHome * r.h.attack;
    }
    for (const t of list) t.defense = (t.scored + priorGoals) / (t.expected + priorGoals);
    rescale('defense');

    // Promedio de goles de local y visitante que deja todo consistente.
    let expectedHome = 0;
    let expectedAway = 0;
    for (const r of rows) {
      expectedHome += r.w * r.h.attack * r.a.defense;
      expectedAway += r.w * r.a.attack * r.h.defense;
    }
    muHome = (sumHome + MU_PRIOR_MATCHES * MU_PRIOR_HOME) / (expectedHome + MU_PRIOR_MATCHES);
    muAway = (sumAway + MU_PRIOR_MATCHES * MU_PRIOR_AWAY) / (expectedAway + MU_PRIOR_MATCHES);
  }

  const ratings = new Map();
  for (const [id, t] of teams) ratings.set(id, { attack: t.attack, defense: t.defense, weight: t.weight });
  return { muHome, muAway, teams: ratings, matches: matches.length };
}

function poissonPmf(lambda) {
  const pmf = new Array(MAX_GOALS + 1);
  pmf[0] = Math.exp(-lambda);
  for (let k = 1; k <= MAX_GOALS; k += 1) pmf[k] = (pmf[k - 1] * lambda) / k;
  return pmf;
}

function tau(x, y, lambdaHome, lambdaAway, rho) {
  if (x === 0 && y === 0) return Math.max(0, 1 - lambdaHome * lambdaAway * rho);
  if (x === 0 && y === 1) return Math.max(0, 1 + lambdaHome * rho);
  if (x === 1 && y === 0) return Math.max(0, 1 + lambdaAway * rho);
  if (x === 1 && y === 1) return Math.max(0, 1 - rho);
  return 1;
}

// matrix[x][y] = probabilidad de que termine x-y (suma 1).
function scoreMatrix(lambdaHome, lambdaAway, rho = RHO) {
  const pHome = poissonPmf(lambdaHome);
  const pAway = poissonPmf(lambdaAway);
  const matrix = [];
  let total = 0;
  for (let x = 0; x <= MAX_GOALS; x += 1) {
    const row = [];
    for (let y = 0; y <= MAX_GOALS; y += 1) {
      const p = pHome[x] * pAway[y] * tau(x, y, lambdaHome, lambdaAway, rho);
      row.push(p);
      total += p;
    }
    matrix.push(row);
  }
  return matrix.map((row) => row.map((p) => p / total));
}

const outcomeOf = (home, away) => (home > away ? 'HOME' : home === away ? 'DRAW' : 'AWAY');

function summarize(matrix) {
  let home = 0;
  let draw = 0;
  let away = 0;
  const cells = [];
  for (let x = 0; x <= MAX_GOALS; x += 1) {
    for (let y = 0; y <= MAX_GOALS; y += 1) {
      const p = matrix[x][y];
      if (x > y) home += p;
      else if (x === y) draw += p;
      else away += p;
      cells.push({ home: x, away: y, probability: p });
    }
  }
  cells.sort((a, b) => b.probability - a.probability);

  const outcome = home >= draw && home >= away ? 'HOME' : away > draw ? 'AWAY' : 'DRAW';
  return {
    outcome,
    probabilities: { home, draw, away },
    // Marcador más probable dentro del resultado favorito (así nunca contradice al ganador).
    predictedScore: cells.find((c) => outcomeOf(c.home, c.away) === outcome),
    topScores: cells.slice(0, 5),
  };
}

const clampLambda = (value) => Math.min(MAX_LAMBDA, Math.max(MIN_LAMBDA, value));

// Un equipo sin historial cuenta como "promedio de la liga" (weight 0 lo delata).
function predictMatch(model, homeId, awayId) {
  const home = model.teams.get(homeId) || NEUTRAL;
  const away = model.teams.get(awayId) || NEUTRAL;
  const lambdaHome = clampLambda(model.muHome * home.attack * away.defense);
  const lambdaAway = clampLambda(model.muAway * away.attack * home.defense);
  return {
    ...summarize(scoreMatrix(lambdaHome, lambdaAway)),
    expectedGoals: { home: lambdaHome, away: lambdaAway },
    homeMatches: home.weight,
    awayMatches: away.weight,
  };
}

module.exports = { fitModel, predictMatch, scoreMatrix, summarize, poissonPmf, MAX_GOALS };
