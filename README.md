# Pronosticador de partidos

Ingresa un partido de fútbol y obtén el resultado más probable: ganador, marcador estimado y probabilidades, junto a los partidos en vivo y próximos de cada liga. Diseño con los colores de Bolivia. Sin dependencias: solo Node.js.

## Correrlo en tu computadora

Requisito: [Node.js 18 o superior](https://nodejs.org).

**1. Token gratuito** → regístrate en <https://www.football-data.org/client/register>. Te llega por correo.

**2. Un solo comando:**

```bash
git clone -b claude/admiring-bohr-esigpw https://github.com/jonajaldin/pronosticadordepartidos.git && cd pronosticadordepartidos && npm start
```

La primera vez pide el token: pégalo y presiona Enter (queda guardado en `.env`). Luego abre <http://localhost:3000>.
Las próximas veces basta `npm start` dentro de la carpeta.

> Windows: usa Git Bash, CMD o PowerShell 7. En PowerShell 5 cambia cada `&&` por `;`.

**3. Verificar la conexión real (opcional):** `npm run check` (o `npm run check -- PL` para otra liga). Prueba el token, el plan y el formato de los datos, y muestra un pronóstico de ejemplo.

## API elegida: football-data.org (v4)

De la lista [public-apis](https://github.com/public-apis/public-apis) (sección *Sports & Fitness*) es la que entrega lo que necesita un pronóstico: todos los partidos de la temporada con marcadores, fechas y estado, en un formato estable.

| Opción de la lista | Auth | Por qué no |
|---|---|---|
| Football Standings | No | Solo tablas de posiciones, sin partidos |
| OpenLigaDB | No | Ligas alemanas |
| SportScore, QiuXiaoCe Football, Bet Better | No | No se pudo leer su documentación al desarrollar (dominios bloqueados en el entorno): no se escribió código a ciegas |
| **football-data.org** | **Token gratis** | **Elegida** |

**Plan gratuito** (suficiente para esta app): 12 competencias (la app usa 10 con tabla única), fixtures, resultados y tablas, 10 consultas por minuto. Deja fuera alineaciones, goleadores y tarjetas, que la app no usa. La app respeta el límite: guarda respuestas en memoria (1 min si hay partido en juego, 5 min si no), junta consultas simultáneas y espera su turno.

Ligas disponibles: LaLiga, UEFA Champions League, Premier League, Serie A, Bundesliga, Ligue 1, Brasileirão Série A, Primeira Liga, Eredivisie y Championship. La liga boliviana no está en el plan gratuito.

## Cómo pronostica

Con los partidos terminados de la temporada actual y la anterior (si tu plan la incluye) calcula el ataque y la defensa de cada equipo, con más peso para lo reciente, y de ahí los goles esperados de cada lado. De esos goles sale la probabilidad de cada marcador, y de ahí el ganador más probable. Es una estimación estadística, no una garantía ni consejo de apuestas.

## Endpoints locales

| Ruta | Devuelve |
|---|---|
| `GET /api/status` | Si hay token y la lista de competencias |
| `GET /api/fixtures?competition=PD` | Equipos, partidos en vivo, próximos y pronóstico de cada uno |
| `GET /api/predict?competition=PD&home=Real Madrid&away=Barcelona` | Pronóstico detallado. Acepta nombre, abreviatura, parte del nombre (sin tildes) o id |

Los errores llegan como `{ "error": { "code", "message", "hint", "retryAfter" } }`. Códigos: `missing_token`, `invalid_token`, `blocked`, `restricted`, `rate_limited`, `timeout`, `network`, `upstream_error`, `bad_response`, `team_not_found`, `ambiguous_team`, entre otros.

## Configuración (`.env`)

| Variable | Por defecto | |
|---|---|---|
| `FOOTBALL_DATA_TOKEN` | — | Token de football-data.org |
| `PORT` | `3000` | Puerto |
| `HOST` | `127.0.0.1` | Solo tu computadora. Con `0.0.0.0` otros equipos de tu red usarían tu cuota |

## Estructura

```
server.js            servidor local: interfaz + API, y pide el token la primera vez
src/footballData.js  conexión con la API: timeout, reintentos, límite, caché, errores
src/predictor.js     modelo de goles (Poisson, ataque y defensa por equipo)
src/service.js       une API + modelo, competencias y búsqueda de equipos
public/              interfaz (HTML, CSS y JS sin dependencias)
scripts/check.js     npm run check
test/                npm test (sin red: usan una API simulada en test-support/)
```

---

## Skills de Claude Code (opcional)

Proyecto con las [sports-skills](https://github.com/machina-sports/sports-skills) de Machina Sports
instaladas para Claude Code (`.claude/skills/` → `.agents/skills/`).

### Cómo probarlo

1. Abre una sesión de Claude Code sobre este repo. El hook `.claude/hooks/session-start.sh`
   instala automáticamente el CLI `sports-skills` (`pip install sports-skills`).
2. Pide cosas en lenguaje natural, por ejemplo:
   - "¿Quién juega hoy en LaLiga y cuál es el pronóstico?"
   - "Tabla de la Premier League"
   - "Convierte cuota -150 a probabilidad y calcula Kelly con 55%"
3. O usa el CLI directamente:
   ```bash
   sports-skills football get_daily_schedule
   sports-skills football get_season_standings --season_id=premier-league-2025
   sports-skills betting convert_odds --odds=-150 --from_format=american
   ```

### Red necesaria (Claude Code en la web)

Si usas Claude Code en la nube, el entorno debe permitir estos dominios
(menú del entorno → Edit → Network access):

| Uso | Dominios |
|-----|----------|
| Fútbol | `site.api.espn.com`, `site.web.api.espn.com`, `understat.com`, `api.clubelo.com`, `www.football-data.co.uk`, `fantasy.premierleague.com`, `www.transfermarkt.com`, `raw.githubusercontent.com` |
| Mercados de predicción | `gamma-api.polymarket.com`, `clob.polymarket.com`, `api.elections.kalshi.com` |
| Noticias / logos | `news.google.com`, `www.thesportsdb.com` |

La skill `betting` (cálculo de cuotas, Kelly, arbitraje) no necesita red.

> Nota: `polymarket-trading` puede operar con dinero real y `machina` / `world-cup` son servicios de pago;
> solo se usan si se piden explícitamente.
>
> Para correr **el pronosticador** desde Claude Code en la web, agrega también `api.football-data.org` a ese listado.
