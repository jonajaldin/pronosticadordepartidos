# Pronosticador de partidos

Proyecto con las [sports-skills](https://github.com/machina-sports/sports-skills) de Machina Sports
instaladas para Claude Code (`.claude/skills/` → `.agents/skills/`).

## Cómo probarlo

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

## Red necesaria (Claude Code en la web)

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
