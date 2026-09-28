'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadEnvFile, readConfig, saveToken } = require('../src/config');

function tempFile(t, content, encoding) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pronosticador-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  if (content !== undefined) fs.writeFileSync(file, content, encoding);
  return file;
}

test('loadEnvFile lee KEY=VALUE, comillas, export y comentarios', (t) => {
  const file = tempFile(t, '# comentario\nFOOTBALL_DATA_TOKEN="abc123"\nexport PORT=4000\n\nHOST = 0.0.0.0 \n');
  const env = {};
  assert.equal(loadEnvFile(file, env), true);
  assert.deepEqual(env, { FOOTBALL_DATA_TOKEN: 'abc123', PORT: '4000', HOST: '0.0.0.0' });
});

test('loadEnvFile no pisa variables que ya existen, salvo que estén vacías', (t) => {
  const file = tempFile(t, 'A=archivo\nB=archivo\n');
  const env = { A: 'entorno', B: '' };
  loadEnvFile(file, env);
  assert.equal(env.A, 'entorno');
  assert.equal(env.B, 'archivo');
});

test('loadEnvFile entiende UTF-16 con BOM (PowerShell 5) y UTF-8 con BOM', (t) => {
  const utf16 = tempFile(t, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('FOOTBALL_DATA_TOKEN=xyz\r\n', 'utf16le')]));
  const env16 = {};
  loadEnvFile(utf16, env16);
  assert.equal(env16.FOOTBALL_DATA_TOKEN, 'xyz');

  const utf8 = tempFile(t, '﻿FOOTBALL_DATA_TOKEN=uvw\r\n');
  const env8 = {};
  loadEnvFile(utf8, env8);
  assert.equal(env8.FOOTBALL_DATA_TOKEN, 'uvw');
});

test('loadEnvFile devuelve false si no existe el archivo', (t) => {
  assert.equal(loadEnvFile(tempFile(t), {}), false);
});

test('readConfig aplica valores por defecto y limpia el token', () => {
  const config = readConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.token, '');
  assert.equal(config.baseUrl, 'https://api.football-data.org/v4');
  assert.equal(config.requestsPerMinute, 10);

  const custom = readConfig({ PORT: 'abc', FOOTBALL_DATA_TOKEN: '  "tok"  ', FOOTBALL_DATA_BASE_URL: 'http://x/v4///' });
  assert.equal(custom.port, 3000);
  assert.equal(custom.token, 'tok');
  assert.equal(custom.baseUrl, 'http://x/v4');
});

test('saveToken crea el archivo, reemplaza el token y conserva el resto', (t) => {
  const file = tempFile(t);
  saveToken('primero', file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'FOOTBALL_DATA_TOKEN=primero\n');

  fs.writeFileSync(file, 'PORT=4000\nFOOTBALL_DATA_TOKEN=viejo\nHOST=0.0.0.0\n');
  saveToken('nuevo', file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'PORT=4000\nHOST=0.0.0.0\nFOOTBALL_DATA_TOKEN=nuevo\n');
});
