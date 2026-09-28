'use strict';

(() => {
  const TIME_ZONE = 'America/La_Paz';
  const REFRESH_MS = 60_000;
  const STORAGE_KEY = 'pronosticador.liga';
  const LOW_DATA_MATCHES = 4;
  const LIVE_LABEL = {
    IN_PLAY: 'EN VIVO',
    LIVE: 'EN VIVO',
    PAUSED: 'ENTRETIEMPO',
    EXTRA_TIME: 'ALARGUE',
    PENALTY_SHOOTOUT: 'PENALES',
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    config: $('config'),
    form: $('form'),
    liga: $('liga'),
    local: $('local'),
    visita: $('visita'),
    equipos: $('equipos'),
    enviar: $('enviar'),
    aviso: $('aviso'),
    resultado: $('resultado'),
    partidos: $('partidos'),
    estado: $('estado'),
    actualizar: $('actualizar'),
  };
  const state = { liga: null, tokenConfigured: false, fixturesToken: 0, predictToken: 0, lastLoad: 0 };

  const kickoffFormat = new Intl.DateTimeFormat('es-BO', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const clockFormat = new Intl.DateTimeFormat('es-BO', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const decimals = new Intl.NumberFormat('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ------------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------------
  // Crea elementos con textContent: nada de lo que llega de la API se interpreta como HTML.
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  class UiError extends Error {
    constructor(message, { hint = null, retryAfter = null } = {}) {
      super(message);
      this.hint = hint;
      this.retryAfter = retryAfter;
    }
  }

  async function api(path, params = {}) {
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new UiError('No se pudo hablar con la aplicación.', {
        hint: 'Revisa que la terminal donde ejecutaste npm start siga abierta.',
      });
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const error = (body && body.error) || {};
      throw new UiError(error.message || `Error ${res.status}`, { hint: error.hint, retryAfter: error.retryAfter });
    }
    return body;
  }

  const percent = (value) => (value > 0 && value < 0.005 ? '<1%' : `${Math.round(value * 100)}%`);
  const scoreText = (home, away) => `${home} – ${away}`;
  const verdictText = (outcome, home, away) =>
    outcome === 'HOME' ? `Gana ${home.shortName}` : outcome === 'AWAY' ? `Gana ${away.shortName}` : 'Empate';
  const outcomeProbability = (outcome, p) => (outcome === 'HOME' ? p.home : outcome === 'AWAY' ? p.away : p.draw);

  function crest(team) {
    const placeholder = () => h('span', { class: 'escudo--vacio', 'aria-hidden': 'true' });
    if (!team.crest) return placeholder();
    const img = h('img', { class: 'escudo', src: team.crest, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(placeholder()));
    return img;
  }

  const setStatus = (text) => {
    ui.estado.textContent = text;
  };

  function clearNotice() {
    ui.aviso.hidden = true;
    ui.aviso.replaceChildren();
  }

  function showNotice(error, kind = 'error') {
    const lines = [h('p', {}, h('strong', { text: error.message }))];
    if (error.hint) lines.push(h('p', { text: error.hint }));
    ui.aviso.className = kind === 'info' ? 'aviso aviso--info' : 'aviso';
    ui.aviso.replaceChildren(...lines);
    ui.aviso.hidden = false;
  }

  function errorText(error) {
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  }

  const rememberedLeague = () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const rememberLeague = (code) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // modo privado o almacenamiento bloqueado: no pasa nada
    }
  };

  // ------------------------------------------------------------------------
  // Partidos en vivo y próximos
  // ------------------------------------------------------------------------
  function teamLine(team) {
    return h('div', { class: 'equipo' }, crest(team), h('span', { text: team.shortName }));
  }

  function fixtureRow(match) {
    const live = Object.hasOwn(LIVE_LABEL, match.status);
    const when = kickoffFormat.format(new Date(match.kickoff));
    const p = match.prediction;

    const head = h(
      'div',
      { class: 'partido__fila' },
      live
        ? h('span', { class: 'en-vivo', text: LIVE_LABEL[match.status] })
        : h('span', { class: 'partido__hora', text: when }),
      live ? h('span', { class: 'marcador', text: scoreText(match.score.home ?? 0, match.score.away ?? 0) }) : null,
    );
    const prediction = p
      ? h('span', {
          class: 'pronostico',
          text: `Pronóstico ${scoreText(p.predictedScore.home, p.predictedScore.away)} · ${verdictText(p.outcome, match.home, match.away)} ${percent(outcomeProbability(p.outcome, p.probabilities))}`,
        })
      : null;

    const button = h(
      'button',
      {
        class: 'partido',
        type: 'button',
        'aria-label': `${match.home.shortName} contra ${match.away.shortName}, ${live ? LIVE_LABEL[match.status].toLowerCase() : when}. Ver pronóstico`,
        onclick: () => pickMatch(match),
      },
      head,
      h('div', { class: 'partido__equipos' }, teamLine(match.home), teamLine(match.away)),
      prediction,
    );
    return h('li', {}, button);
  }

  function renderFixtures(data) {
    const rows = [...data.live, ...data.upcoming];
    ui.partidos.replaceChildren(
      ...(rows.length
        ? rows.map(fixtureRow)
        : [h('li', { class: 'vacio', text: 'No hay partidos próximos en esta competencia por ahora.' })]),
    );

    const parts = [`${data.competition.name}${data.season.label ? ` · temporada ${data.season.label}` : ''}`];
    parts.push(`actualizado ${clockFormat.format(new Date(data.meta.fetchedAt))}`);
    if (data.meta.stale) {
      const reason = data.meta.staleReason;
      parts.push(`no se pudo refrescar (${reason ? reason.message : 'error desconocido'}); se muestran datos guardados`);
    }
    setStatus(parts.join(' · '));
  }

  function renderTeams(teams) {
    ui.equipos.replaceChildren(...teams.map((team) => h('option', { value: team.shortName, label: team.name })));
  }

  async function loadFixtures({ silent = false } = {}) {
    const token = ++state.fixturesToken;
    if (!silent) {
      setStatus('Cargando partidos…');
      ui.partidos.replaceChildren();
    }
    ui.actualizar.disabled = true;
    try {
      const data = await api('/api/fixtures', { competition: state.liga });
      if (token !== state.fixturesToken) return; // el usuario ya cambió de liga
      state.lastLoad = Date.now();
      renderTeams(data.teams);
      renderFixtures(data);
    } catch (error) {
      if (token !== state.fixturesToken) return;
      const kept = ui.partidos.children.length > 0;
      setStatus(`${errorText(error)}${kept ? ' Se muestran los datos anteriores.' : ''}`);
    } finally {
      if (token === state.fixturesToken) ui.actualizar.disabled = false;
    }
  }

  // ------------------------------------------------------------------------
  // Pronóstico
  // ------------------------------------------------------------------------
  function duelTeam(team, role) {
    return h('div', { class: 'duelo__equipo' }, crest(team), h('span', { text: team.shortName }), h('small', { text: role }));
  }

  function probabilityBar(p, home, away) {
    const parts = [
      ['l', p.home, `Local ${percent(p.home)}`],
      ['e', p.draw, `Empate ${percent(p.draw)}`],
      ['v', p.away, `Visitante ${percent(p.away)}`],
    ];
    const bar = h('div', {
      class: 'barra',
      role: 'img',
      'aria-label': `Probabilidades: ${home.shortName} ${percent(p.home)}, empate ${percent(p.draw)}, ${away.shortName} ${percent(p.away)}`,
    });
    for (const [cls, value] of parts) {
      const segment = h('span', { class: cls });
      segment.style.flexGrow = String(Math.max(value, 0.001));
      bar.append(segment);
    }
    const legend = h('div', { class: 'leyenda' }, ...parts.map(([cls, , label]) => h('span', { class: cls, text: label })));
    return h('div', {}, bar, legend);
  }

  function renderResult(data) {
    const { home, away, prediction: p, basis, meta } = data;
    const winnerShare = outcomeProbability(p.outcome, p.probabilities);

    const lowData = [
      basis.homeMatches < LOW_DATA_MATCHES ? home.shortName : null,
      basis.awayMatches < LOW_DATA_MATCHES ? away.shortName : null,
    ].filter(Boolean);

    const season = basis.season
      ? ` (temporada ${basis.season}${basis.previousSeason === 'used' ? ' y la anterior' : ''})`
      : '';
    const basisText =
      `Basado en ${basis.matches} partidos terminados de ${data.competition.name}${season}. ` +
      `Actualizado ${clockFormat.format(new Date(meta.fetchedAt))}.` +
      (meta.stale ? ' Datos guardados: no se pudo refrescar.' : '');

    const blocks = [
      h('div', { class: 'duelo' }, duelTeam(home, 'Local'), h('span', { class: 'vs', text: 'vs' }), duelTeam(away, 'Visitante')),
      h(
        'div',
        { class: 'veredicto' },
        h('span', { class: 'veredicto__etiqueta', text: 'Resultado más probable' }),
        h('strong', { text: `${verdictText(p.outcome, home, away)} · ${percent(winnerShare)}` }),
        h('span', {}, 'Marcador estimado: ', h('b', { text: scoreText(p.predictedScore.home, p.predictedScore.away) })),
      ),
      probabilityBar(p.probabilities, home, away),
      h('p', {
        class: 'dato',
        text: `Goles esperados: ${home.shortName} ${decimals.format(p.expectedGoals.home)} – ${decimals.format(p.expectedGoals.away)} ${away.shortName}`,
      }),
      h(
        'div',
        {},
        h('h3', { text: 'Marcadores más probables (con cualquier resultado)' }),
        h('ul', { class: 'marcadores' }, ...p.topScores.map((s) => h('li', { text: `${scoreText(s.home, s.away)} · ${percent(s.probability)}` }))),
      ),
      lowData.length
        ? h('div', { class: 'aviso aviso--info' }, h('p', { text: `Hay pocos partidos jugados de ${lowData.join(' y ')}: el pronóstico es menos fiable.` }))
        : null,
      h('p', { class: 'nota', text: basisText }),
    ];
    // replaceChildren convierte null en el texto "null": hay que filtrarlo.
    ui.resultado.replaceChildren(...blocks.filter(Boolean));
  }

  function setBusy(busy) {
    ui.enviar.disabled = busy || !state.tokenConfigured;
    ui.enviar.textContent = busy ? 'Calculando…' : 'Predecir resultado';
  }

  async function predict(homeRef, awayRef) {
    clearNotice();
    const missing = !String(homeRef).trim() ? ui.local : !String(awayRef).trim() ? ui.visita : null;
    if (missing) {
      showNotice(
        { message: 'Escribe el equipo local y el visitante.', hint: 'Elige de la lista que aparece al escribir, o toca un partido de la derecha.' },
        'info',
      );
      missing.focus();
      return;
    }

    const token = ++state.predictToken;
    setBusy(true);
    try {
      const data = await api('/api/predict', { competition: state.liga, home: homeRef, away: awayRef });
      if (token === state.predictToken) renderResult(data);
    } catch (error) {
      if (token !== state.predictToken) return;
      ui.resultado.replaceChildren();
      showNotice(error);
    } finally {
      if (token === state.predictToken) setBusy(false);
    }
  }

  function pickMatch(match) {
    ui.local.value = match.home.shortName;
    ui.visita.value = match.away.shortName;
    predict(match.home.id, match.away.id).then(() => {
      const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      ui.resultado.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'nearest' });
    });
  }

  // ------------------------------------------------------------------------
  // Arranque
  // ------------------------------------------------------------------------
  function selectLeague(code) {
    state.liga = code;
    ui.liga.value = code;
    rememberLeague(code);
    state.predictToken += 1;
    setBusy(false);
    ui.local.value = '';
    ui.visita.value = '';
    ui.equipos.replaceChildren();
    ui.resultado.replaceChildren();
    clearNotice();
    return loadFixtures();
  }

  async function init() {
    try {
      const status = await api('/api/status');
      ui.liga.replaceChildren(
        ...status.competitions.map((c) => h('option', { value: c.code, text: `${c.name} — ${c.country}` })),
      );
      state.tokenConfigured = status.tokenConfigured;
      if (!status.tokenConfigured) {
        ui.config.hidden = false;
        setStatus('Configura tu token para ver los partidos.');
        return;
      }
      ui.liga.disabled = false;
      setBusy(false);
      const saved = rememberedLeague();
      await selectLeague(status.competitions.some((c) => c.code === saved) ? saved : status.competitions[0].code);
    } catch (error) {
      setStatus('');
      showNotice(error);
    }
  }

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    predict(ui.local.value, ui.visita.value);
  });
  ui.liga.addEventListener('change', () => selectLeague(ui.liga.value));
  ui.actualizar.addEventListener('click', () => loadFixtures());

  setInterval(() => {
    if (!document.hidden && state.liga && state.tokenConfigured) loadFixtures({ silent: true });
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.liga && state.tokenConfigured && Date.now() - state.lastLoad > REFRESH_MS) {
      loadFixtures({ silent: true });
    }
  });

  init();
})();
