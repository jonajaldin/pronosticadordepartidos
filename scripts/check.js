'use strict';

// Verifica la conexión REAL con football-data.org: token, plan y formato de los datos.
//   npm run check            (usa LaLiga)
//   npm run check -- PL      (o cualquier código: PD, CL, PL, SA, BL1, FL1, BSA, PPL, DED, ELC)

const { REGISTER_URL, loadEnvFile, readConfig } = require('../src/config');
const { createClient, isFinished } = require('../src/footballData');
const { createService, COMPETITIONS } = require('../src/service');

const ok = (text) => console.log(`  OK     ${text}`);
const bad = (text) => console.log(`  FALLO  ${text}`);

async function main() {
  loadEnvFile();
  const config = readConfig();
  const code = (process.argv[2] || COMPETITIONS[0].code).toUpperCase();

  console.log(`\nProbando football-data.org (${config.baseUrl}) con la competencia ${code}\n`);
  if (!config.token) {
    bad('No hay token. Regístrate gratis en ' + REGISTER_URL);
    bad('y guárdalo en .env como FOOTBALL_DATA_TOKEN=... (o ejecuta npm start para que lo pida).');
    return 1;
  }
  ok(`Token encontrado (${config.token.length} caracteres)`);

  const client = createClient(config);
  const service = createService({ client });

  const { data } = await client.getMatches(code);
  const finished = data.matches.filter(isFinished).length;
  ok(`Temporada ${data.season.label || '?'}: ${data.matches.length} partidos (${finished} terminados)`);
  if (data.skipped > 0) bad(`${data.skipped} partidos ignorados por formato inesperado (normal en eliminatorias con equipos por definir)`);
  if (data.matches.length === 0) {
    bad('La API no devolvió partidos para esta competencia.');
    return 1;
  }

  const fixtures = await service.getFixtures(code);
  ok(`${fixtures.teams.length} equipos, ${fixtures.live.length} en vivo, ${fixtures.upcoming.length} próximos`);
  ok(`Temporada anterior: ${fixtures.meta.previousSeason === 'used' ? 'incluida en el modelo' : 'no disponible en tu plan (se usa solo la actual)'}`);

  const next = fixtures.live[0] || fixtures.upcoming[0];
  const [home, away] = next ? [next.home, next.away] : fixtures.teams.slice(0, 2);
  const result = await service.predict(code, home.id, away.id);
  const p = result.prediction;
  ok(
    `Pronóstico ${home.shortName} vs ${away.shortName}: ${p.predictedScore.home}-${p.predictedScore.away} ` +
      `(local ${Math.round(p.probabilities.home * 100)}% / empate ${Math.round(p.probabilities.draw * 100)}% / ` +
      `visitante ${Math.round(p.probabilities.away * 100)}%)`,
  );
  console.log('\nTodo bien. Ejecuta: npm start\n');
  return 0;
}

main().then(
  (status) => process.exit(status),
  (err) => {
    bad(err.message);
    if (err.hint) console.log(`         -> ${err.hint}`);
    if (!err.hint && !err.code) console.log(err);
    process.exit(1);
  },
);
