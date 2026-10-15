'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const REGISTER_URL = 'https://www.football-data.org/client/register';

// Carga KEY=VALUE desde .env sin pisar variables ya definidas (sin dependencias).
// Acepta UTF-8 y UTF-16 (PowerShell 5 guarda así con `echo x > .env`).
function loadEnvFile(file = ENV_PATH, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return false;
  }
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || env[match[1]]) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return true;
}

function readConfig(env = process.env) {
  const positive = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    port: positive(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    token: (env.FOOTBALL_DATA_TOKEN || '').trim().replace(/^(['"])(.*)\1$/, '$2'),
    baseUrl: (env.FOOTBALL_DATA_BASE_URL || 'https://api.football-data.org/v4').replace(/\/+$/, ''),
    timeoutMs: positive(env.FOOTBALL_DATA_TIMEOUT_MS, 10_000),
    requestsPerMinute: positive(env.FOOTBALL_DATA_RPM, 10),
  };
}

// Guarda (o reemplaza) FOOTBALL_DATA_TOKEN en .env conservando el resto del archivo.
function saveToken(token, file = ENV_PATH) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  } catch {
    // no existía
  }
  lines = lines.filter((line) => !/^\s*(?:export\s+)?FOOTBALL_DATA_TOKEN\s*=/.test(line));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`FOOTBALL_DATA_TOKEN=${token}`, '');
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}

module.exports = { ROOT, ENV_PATH, REGISTER_URL, loadEnvFile, readConfig, saveToken };
