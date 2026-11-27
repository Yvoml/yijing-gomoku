import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPages } from '../scripts/build-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function temporary(t) {
  await mkdir(join(root, '.local'), { recursive: true });
  const path = await mkdtemp(join(root, '.local', 'pages-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('Pages output contains the playable runtime, canonical engine and no server secrets', async t => {
  const temp = await temporary(t);
  const outputDir = join(temp, 'site');
  const result = await buildPages({ outputDir });
  const html = await readFile(join(outputDir, 'index.html'), 'utf8');
  assert.match(html, /name="yijing-runtime" content="browser"/);
  assert.match(html, /id="board"/);
  assert.match(html, new RegExp(`app\\.js\\?v=${result.buildHash}`));
  assert.doesNotMatch(html, /(?:src|href)=["']\/(?!\/)/);
  for (const name of ['browser/api.js', 'browser/store.js', 'browser/ai.js', 'lib/engine.js', '.nojekyll']) assert.ok(result.files.includes(name));
  for (const name of ['.env', '.env.example', 'package.json', 'server.js', 'lib/db.js', 'lib/ai.js', 'data/gomoku.sqlite', '.local/github.mjs']) assert.ok(!result.files.includes(name));
  assert.deepEqual(await readFile(join(outputDir, 'lib/engine.js')), await readFile(join(root, 'lib/engine.js')));
  const api = await readFile(join(outputDir, 'browser/api.js'), 'utf8');
  assert.match(api, new RegExp(`\\.\\./lib/engine\\.js\\?v=${result.buildHash}`));
  assert.match(api, new RegExp(`\\./ai\\.js\\?v=${result.buildHash}`));
  assert.doesNotMatch(api, /from\s+['"]node:/);
});

test('generated assets and every module resolve below a GitHub project subpath', async t => {
  const temp = await temporary(t);
  const { outputDir } = await buildPages({ outputDir: join(temp, 'site') });
  const prefix = '/yijing-gomoku/';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    const target = resolve(outputDir, rel);
    if (relative(outputDir, target).startsWith('..')) { response.writeHead(403).end(); return; }
    try { response.end(await readFile(target)); } catch { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = new URL(prefix, origin);
  const html = await fetch(home).then(response => response.text());
  const resources = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]).filter(path => !/^(?:data:|https?:|#)/.test(path));
  const visited = new Set();
  const queue = resources.map(path => new URL(path, home));
  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    assert.ok(url.pathname.startsWith(prefix), `资源逃离项目路径：${url.pathname}`);
    const response = await fetch(url);
    assert.equal(response.status, 200, `资源不存在：${url.pathname}`);
    const source = await response.text();
    if (!/\.m?js$/.test(url.pathname)) continue;
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g)].map(match => match[1]);
    for (const path of imports) {
      assert.match(path, /\?v=[a-f0-9]{16}$/);
      queue.push(new URL(path, url));
    }
  }
  assert.ok([...visited].some(url => url.includes('/browser/api.js')));
  assert.ok([...visited].some(url => url.includes('/lib/engine.js')));
});

test('build refuses source or unowned directories and only replaces its own output', async t => {
  const temp = await temporary(t);
  await assert.rejects(buildPages({ outputDir: root }), /不能覆盖/);
  await assert.rejects(buildPages({ outputDir: join(root, 'public', 'site') }), /不能覆盖/);
  await assert.rejects(buildPages({ outputDir: resolve(root, '..', 'outside-site') }), /项目目录内/);
  await assert.rejects(buildPages({ outputDir: temp }), /不是本项目生成/);
  const outputDir = join(temp, 'site');
  const first = await buildPages({ outputDir });
  await writeFile(join(outputDir, 'stale-file.txt'), 'old');
  const second = await buildPages({ outputDir });
  assert.equal(first.buildHash, second.buildHash);
  await assert.rejects(readFile(join(outputDir, 'stale-file.txt')), { code: 'ENOENT' });
});
