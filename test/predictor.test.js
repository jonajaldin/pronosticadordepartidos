'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fitModel, predictMatch, scoreMatrix, summarize, MAX_GOALS } = require('../src/predictor');
const { normalizeMatchesResponse, isFinished } = require('../src/footballData');
const { buildLeague, buildTwoSeasons, makeStrengths, DAY } = require('../test-support/synthetic-league');

const NOW = Date.UTC(2026, 8, 28);
const sum = (values) => values.reduce((a, b) => a + b, 0);

function correlation(a, b) {
  const n = a.length;
  const ma = sum(a) / n;
  const mb = sum(b) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

const finished = (league) => normalizeMatchesResponse(league.body).matches.filter(isFinished);
const match = (home, away, homeGoals, awayGoals, daysAgo = 1) => ({
  home: { id: home },
  away: { id: away },
  score: { home: homeGoals, away: awayGoals },
  timestamp: NOW - daysAgo * DAY,
});

// Correlación entre los goles esperados del modelo y los reales de la liga sintética.
function lambdaCorrelation(model, truth) {
  const ids = [...truth.attack.keys()];
  const fitted = [];
  const real = [];
  for (const h of ids) {
    for (const a of ids) {
      if (h === a) continue;
      fitted.push(Math.log(predictMatch(model, h, a).expectedGoals.home));
      real.push(Math.log(truth.muHome * truth.attack.get(h) * truth.defense.get(a)));
    }
  }
  return correlation(fitted, real);
}

test('la matriz de marcadores suma 1 en cualquier caso', () => {
  for (const [home, away] of [[0.05, 0.05], [1.6, 1.1], [3.5, 0.4], [6, 6]]) {
    const matrix = scoreMatrix(home, away);
    assert.equal(matrix.length, MAX_GOALS + 1);
    assert.ok(Math.abs(sum(matrix.flat()) - 1) < 1e-12, `λ=${home},${away}`);
    assert.ok(matrix.flat().every((p) => p >= 0));
  }
});

test('el favorito por goles esperados gana y su marcador no contradice al ganador', () => {
  const strong = summarize(scoreMatrix(2.2, 0.7));
  assert.equal(strong.outcome, 'HOME');
  assert.ok(strong.probabilities.home > 0.6);
  assert.ok(strong.predictedScore.home > strong.predictedScore.away);

  const away = summarize(scoreMatrix(0.6, 2.0));
  assert.equal(away.outcome, 'AWAY');
  assert.ok(away.predictedScore.away > away.predictedScore.home);

  const p = strong.probabilities;
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-12);
});

test('cuando el empate es lo más probable, el marcador estimado es un empate', () => {
  const even = summarize(scoreMatrix(0.9, 0.9));
  assert.equal(even.outcome, 'DRAW');
  assert.equal(even.predictedScore.home, even.predictedScore.away);
});

test('la corrección de marcadores bajos aumenta los empates', () => {
  const draw = (rho) => summarize(scoreMatrix(1.3, 1.1, rho)).probabilities.draw;
  assert.ok(draw(-0.1) > draw(0));
});

test('sin partidos terminados no hay modelo', () => {
  assert.equal(fitModel([], { now: NOW }), null);
});

test('recupera la fuerza real de los equipos y el local rinde más que el visitante', () => {
  const { current, previous, truth } = buildTwoSeasons({ now: NOW, seed: 7 });
  const both = fitModel([...finished(previous), ...finished(current)], { now: NOW });

  assert.ok(both.muHome > both.muAway);
  assert.ok(lambdaCorrelation(both, truth) > 0.85);

  const ids = [...truth.attack.keys()];
  const fittedAttack = ids.map((id) => both.teams.get(id).attack);
  const trueAttack = ids.map((id) => truth.attack.get(id));
  assert.ok(correlation(fittedAttack, trueAttack) > 0.85);
});

test('usar también la temporada anterior mejora el pronóstico a inicio de temporada', () => {
  const { current, previous, truth } = buildTwoSeasons({ now: NOW, seed: 11, daysIn: 30 });
  const onlyCurrent = fitModel(finished(current), { now: NOW });
  const both = fitModel([...finished(previous), ...finished(current)], { now: NOW });
  assert.ok(lambdaCorrelation(both, truth) > lambdaCorrelation(onlyCurrent, truth));
});

test('en partidos que no vio, supera al pronóstico ingenuo y se acerca al ideal', () => {
  const start = Date.UTC(2025, 7, 9);
  const kind = (h, a) => (h > a ? 'home' : h === a ? 'draw' : 'away');
  const loss = (p, k) => -Math.log(Math.max(p[k], 1e-9));
  const totals = { model: 0, naive: 0, ideal: 0, hitModel: 0, hitNaive: 0, n: 0 };
  const best = (p) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];

  for (const seed of [3, 7, 11, 19, 23, 31]) {
    const truth = makeStrengths(seed);
    const previous = finished(buildLeague({ seed: seed + 1, seasonStart: start - 365 * DAY, now: start, strengths: truth }));
    const season = finished(buildLeague({ seed, seasonStart: start, now: start + 400 * DAY, strengths: truth })).sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    // Entrena con la temporada anterior y 120 partidos de la actual; prueba con el resto.
    const train = [...previous, ...season.slice(0, 120)];
    const model = fitModel(train, { now: season[119].timestamp });

    const counts = { home: 0, draw: 0, away: 0 };
    for (const m of train) counts[kind(m.score.home, m.score.away)] += 1;
    const naive = { home: counts.home / train.length, draw: counts.draw / train.length, away: counts.away / train.length };

    for (const m of season.slice(120)) {
      const actual = kind(m.score.home, m.score.away);
      const predicted = predictMatch(model, m.home.id, m.away.id).probabilities;
      const ideal = summarize(
        scoreMatrix(
          truth.muHome * truth.attack.get(m.home.id) * truth.defense.get(m.away.id),
          truth.muAway * truth.attack.get(m.away.id) * truth.defense.get(m.home.id),
        ),
      ).probabilities;
      totals.model += loss(predicted, actual);
      totals.naive += loss(naive, actual);
      totals.ideal += loss(ideal, actual);
      totals.hitModel += best(predicted) === actual ? 1 : 0;
      totals.hitNaive += best(naive) === actual ? 1 : 0;
      totals.n += 1;
    }
  }

  const per = (value) => value / totals.n;
  assert.ok(per(totals.model) < per(totals.naive) - 0.05, `error modelo ${per(totals.model)} vs ingenuo ${per(totals.naive)}`);
  assert.ok(per(totals.model) - per(totals.ideal) < 0.03, `error modelo ${per(totals.model)} vs ideal ${per(totals.ideal)}`);
  assert.ok(per(totals.hitModel) > per(totals.hitNaive) + 0.03, `acierto modelo ${per(totals.hitModel)} vs ingenuo ${per(totals.hitNaive)}`);
});

test('con un solo partido no se va a extremos (los promedios de la liga tienen un mínimo de duda)', () => {
  const model = fitModel([match(1, 2, 5, 0)], { now: NOW });
  const p = predictMatch(model, 1, 2);
  assert.ok(p.expectedGoals.home < 3, `λ local = ${p.expectedGoals.home}`);
  assert.ok(p.expectedGoals.away > 0.3, `λ visitante = ${p.expectedGoals.away}`);
});

test('los partidos viejos pesan menos', () => {
  const model = fitModel([match(1, 2, 1, 1, 0), match(1, 3, 1, 1, 600)], { now: NOW, halfLifeDays: 300 });
  assert.ok(Math.abs(model.teams.get(2).weight - 1) < 1e-9);
  assert.ok(Math.abs(model.teams.get(3).weight - 0.25) < 1e-9);
  assert.ok(Math.abs(model.teams.get(1).weight - 1.25) < 1e-9);
});

test('un equipo sin historial cuenta como promedio y lo avisa con weight 0', () => {
  const model = fitModel([match(1, 2, 2, 1), match(2, 1, 0, 0)], { now: NOW });
  const p = predictMatch(model, 1, 999);
  assert.equal(p.awayMatches, 0);
  assert.ok(p.homeMatches > 0);
  assert.ok(Number.isFinite(p.expectedGoals.home) && Number.isFinite(p.expectedGoals.away));
});

test('todos 0-0 no produce valores inválidos', () => {
  const model = fitModel([match(1, 2, 0, 0), match(2, 1, 0, 0), match(1, 3, 0, 0)], { now: NOW });
  const p = predictMatch(model, 1, 2);
  assert.ok(p.expectedGoals.home > 0 && p.expectedGoals.away > 0);
  assert.ok(Math.abs(sum(Object.values(p.probabilities)) - 1) < 1e-12);
});
