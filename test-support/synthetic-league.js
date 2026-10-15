'use strict';

// Liga sintética con el mismo formato JSON que football-data.org (v4), para probar sin red.
// Los equipos tienen fuerza real conocida (`truth`), así se puede comprobar que el modelo la recupera.

const DAY = 86_400_000;

const TEAMS = [
  [57, 'Arsenal FC', 'Arsenal', 'ARS'],
  [58, 'Aston Villa FC', 'Aston Villa', 'AVL'],
  [61, 'Chelsea FC', 'Chelsea', 'CHE'],
  [62, 'Everton FC', 'Everton', 'EVE'],
  [63, 'Fulham FC', 'Fulham', 'FUL'],
  [64, 'Liverpool FC', 'Liverpool', 'LIV'],
  [65, 'Manchester City FC', 'Man City', 'MCI'],
  [66, 'Manchester United FC', 'Man United', 'MUN'],
  [67, 'Newcastle United FC', 'Newcastle', 'NEW'],
  [73, 'Tottenham Hotspur FC', 'Tottenham', 'TOT'],
  [76, 'Wolverhampton Wanderers FC', 'Wolverhampton', 'WOL'],
  [328, 'Burnley FC', 'Burnley', 'BUR'],
  [340, 'Southampton FC', 'Southampton', 'SOU'],
  [354, 'Crystal Palace FC', 'Crystal Palace', 'CRY'],
  [397, 'Brighton & Hove Albion FC', 'Brighton Hove', 'BHA'],
  [402, 'Brentford FC', 'Brentford', 'BRE'],
  [563, 'West Ham United FC', 'West Ham', 'WHU'],
  [351, 'Nottingham Forest FC', 'Nottingham', 'NFO'],
  [1044, 'AFC Bournemouth', 'Bournemouth', 'BOU'],
  [389, 'Luton Town FC', 'Luton', 'LUT'],
].map(([id, name, shortName, tla]) => ({
  id,
  name,
  shortName,
  tla,
  crest: `https://crests.football-data.org/${id}.png`,
}));

// Generador pseudoaleatorio con semilla (mulberry32): los tests son repetibles.
function createRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

function poisson(rand, lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

function roundRobin(ids) {
  const n = ids.length;
  const ring = ids.slice();
  const rounds = [];
  for (let r = 0; r < n - 1; r += 1) {
    const pairs = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = ring[i];
      const b = ring[n - 1 - i];
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    ring.splice(1, 0, ring.pop());
  }
  return rounds;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoSecond = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function makeStrengths(seed, teams = TEAMS) {
  const rand = createRandom(seed);
  const attack = new Map();
  const defense = new Map();
  for (const team of teams) {
    attack.set(team.id, Math.exp(0.35 * gaussian(rand)));
    defense.set(team.id, Math.exp(0.3 * gaussian(rand)));
  }
  return { attack, defense, muHome: 1.5, muAway: 1.15 };
}

// seasonStart: instante (ms) de la primera fecha. Una fecha por semana, doble vuelta.
// Los partidos con inicio + 2 h anterior a `now` están terminados; el resto, programados.
// liveNow: fuerza un partido "en juego" (55 minutos) para probar el modo en vivo.
function buildLeague({
  seed = 7,
  seasonStart,
  now = Date.now(),
  teams = TEAMS,
  strengths = makeStrengths(seed, teams),
  liveNow = false,
} = {}) {
  const startYear = new Date(seasonStart).getUTCFullYear(); // la API identifica la temporada por su año de inicio
  const rand = createRandom(seed + 1000);
  const ids = teams.map((t) => t.id);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const first = roundRobin(ids);
  const rounds = [...first, ...first.map((pairs) => pairs.map(([h, a]) => [a, h]))];
  const endDate = seasonStart + (rounds.length + 1) * 7 * DAY;

  const season = {
    id: 1000 + startYear,
    startDate: isoDay(seasonStart),
    endDate: isoDay(endDate),
    currentMatchday: 1,
    winner: null,
  };
  const competition = {
    id: 2021,
    name: 'Premier League',
    code: 'PL',
    type: 'LEAGUE',
    emblem: 'https://crests.football-data.org/PL.png',
  };

  let counter = 0;
  const matches = [];
  rounds.forEach((pairs, r) => {
    pairs.forEach(([homeId, awayId], i) => {
      const kickoff = seasonStart + r * 7 * DAY + Math.floor(i / 4) * DAY + (i % 4) * 9_000_000;
      let status = 'TIMED';
      let home = null;
      let away = null;
      if (kickoff + 2 * 3_600_000 <= now) {
        status = 'FINISHED';
        home = poisson(rand, strengths.muHome * strengths.attack.get(homeId) * strengths.defense.get(awayId));
        away = poisson(rand, strengths.muAway * strengths.attack.get(awayId) * strengths.defense.get(homeId));
      } else if (kickoff - now > 21 * DAY) {
        status = 'SCHEDULED';
      }
      const winner = home === null ? null : home > away ? 'HOME_TEAM' : home < away ? 'AWAY_TEAM' : 'DRAW';
      counter += 1;
      matches.push({
        area: { id: 2072, name: 'England', code: 'ENG' },
        competition,
        season,
        id: startYear * 1000 + counter,
        utcDate: isoSecond(kickoff),
        status,
        matchday: r + 1,
        stage: 'REGULAR_SEASON',
        group: null,
        lastUpdated: isoSecond(Math.min(now, kickoff + 2 * 3_600_000)),
        homeTeam: byId.get(homeId),
        awayTeam: byId.get(awayId),
        score: {
          winner,
          duration: 'REGULAR',
          fullTime: { home, away },
          halfTime: { home: null, away: null },
        },
        odds: { msg: 'Activate Odds-Package in User-Panel to retrieve odds.' },
        referees: [],
      });
    });
  });

  if (liveNow) {
    const target = matches.find((m) => m.status !== 'FINISHED');
    target.status = 'IN_PLAY';
    target.utcDate = isoSecond(now - 55 * 60_000);
    target.score.fullTime = { home: 1, away: 0 };
  }

  const played = matches.filter((m) => m.status === 'FINISHED').length;
  return {
    truth: strengths,
    teams,
    startYear,
    body: {
      filters: { season: String(startYear) },
      resultSet: { count: matches.length, first: season.startDate, last: season.endDate, played },
      competition,
      matches,
    },
  };
}

// Temporada actual (a `daysIn` días de haber empezado) + temporada anterior completa (un año antes).
function buildTwoSeasons({ now = Date.now(), daysIn = 63, seed = 7, liveNow = false } = {}) {
  const strengths = makeStrengths(seed);
  const currentStart = now - daysIn * DAY;
  const lastYear = new Date(currentStart);
  lastYear.setUTCFullYear(lastYear.getUTCFullYear() - 1);

  const current = buildLeague({ seed, seasonStart: currentStart, now, strengths, liveNow });
  const previous = buildLeague({ seed: seed + 1, seasonStart: lastYear.getTime(), now, strengths });
  return { current, previous, truth: strengths, startYear: current.startYear };
}

module.exports = { TEAMS, DAY, buildLeague, buildTwoSeasons, makeStrengths, createRandom, poisson };
