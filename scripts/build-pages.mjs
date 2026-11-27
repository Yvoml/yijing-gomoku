import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const marker = '.yijing-pages-build';
const staticExtensions = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.woff', '.woff2']);
const hash = data => createHash('sha256').update(data).digest('hex').slice(0, 16);
const posix = path => path.split(sep).join('/');

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertNoSymlinks(path) {
  const rel = relative(root, path);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('构建路径必须位于项目目录内。');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await exists(current))?.isSymbolicLink()) throw new Error('构建不允许符号链接。');
  }
}

async function collect(directory, prefix, allowed, files) {
  await assertNoSymlinks(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('静态资源不允许符号链接。');
    if (entry.name.startsWith('.')) continue;
    const target = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collect(source, target, allowed, files);
    else if (entry.isFile() && allowed.has(extname(entry.name).toLowerCase())) files.set(target, await readFile(source));
  }
}

/** Build a self-contained static app that can be served under any project path. */
export async function buildPages({ outputDir = '_site' } = {}) {
  const destination = resolve(root, outputDir);
  const outputRelative = relative(root, destination);
  const firstPart = outputRelative.split(sep)[0];
  if (!outputRelative || ['.git', 'public', 'browser', 'lib', 'scripts', 'test', 'docs', 'data', 'node_modules'].includes(firstPart)) {
    throw new Error('构建目录不能覆盖源码、数据库或仓库根目录。');
  }
  await assertNoSymlinks(destination);
  const output = await exists(destination);
  if (output) {
    if (!output.isDirectory() || !(await exists(join(destination, marker)))?.isFile()) {
      throw new Error('目标目录不是本项目生成的网页目录，已停止以保留已有文件。');
    }
  }

  const files = new Map();
  await collect(join(root, 'public'), '', staticExtensions, files);
  await collect(join(root, 'browser'), 'browser', new Set(['.js', '.mjs']), files);
  await assertNoSymlinks(join(root, 'lib', 'engine.js'));
  files.set('lib/engine.js', await readFile(join(root, 'lib', 'engine.js')));
  for (const required of ['index.html', 'app.js', 'styles.css', 'browser/api.js', 'browser/store.js', 'browser/ai.js']) {
    if (!files.has(required)) throw new Error(`缺少网页版所需文件：${required}`);
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(pkg.version || '')) throw new Error('项目版本号无效。');
  const buildHash = hash([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => `${path}\0${hash(data)}`).join('\n'));
  const moduleHashes = new Map([...files].filter(([path]) => /\.(?:m?js|css)$/.test(path)).map(([path, data]) => [path, hash(data)]));

  // Every generated module import is versioned as well as the entry script.
  // This avoids serving old transitive modules from a CDN cache after release.
  const versionReference = (from, specifier) => {
    if (!specifier.startsWith('.')) return specifier;
    const withoutQuery = specifier.split(/[?#]/)[0];
    const target = posix(relative(root, resolve(root, dirname(from), withoutQuery)));
    return moduleHashes.has(target) ? `${withoutQuery}?v=${buildHash}` : specifier;
  };
  for (const [path, data] of files) {
    if (!/\.(?:m?js|css)$/.test(path)) continue;
    const source = data.toString('utf8');
    const transformed = /\.css$/.test(path) ? source : source
      .replace(/(\bfrom\s*['"])(\.[^'"\r\n]+)(['"])/g, (_all, before, specifier, after) => `${before}${versionReference(path, specifier)}${after}`)
      .replace(/(\bimport\s*\(\s*['"])(\.[^'"\r\n]+)(['"])/g, (_all, before, specifier, after) => `${before}${versionReference(path, specifier)}${after}`);
    files.set(path, Buffer.from(transformed));
  }
  let html = files.get('index.html').toString('utf8');
  html = html.replace(/\s*<meta\s+name=["']yijing-(?:runtime|version|build)["'][^>]*>/gi, '');
  html = html.replace('</head>', `  <meta name="yijing-runtime" content="browser">\n  <meta name="yijing-version" content="${pkg.version}">\n  <meta name="yijing-build" content="${buildHash}">\n</head>`);
  for (const asset of ['app.js', 'styles.css', 'winter.css', 'scene.js']) {
    html = html.replace(new RegExp(`((?:src|href)=["'])(?:\\./|/)?${asset.replace('.', '\\.')}[^"']*(["'])`, 'g'), `$1./${asset}?v=${buildHash}$2`);
  }
  if (/(?:src|href)=["']\/(?!\/)/i.test(html)) throw new Error('网页仍包含站点根路径资源，无法安全部署到项目子路径。');
  files.set('index.html', Buffer.from(html));
  files.set('.nojekyll', Buffer.from(''));
  files.set(marker, Buffer.from(`弈境网页版构建\n${buildHash}\n`));

  // Destination was resolved and validated above. Only our own generated output
  // may be replaced; source trees and arbitrary existing directories are refused.
  if (output) await rm(destination, { recursive: true });
  await mkdir(destination, { recursive: true });
  for (const [path, data] of files) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  return { outputDir: destination, version: pkg.version, buildHash, files: [...files.keys()].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await buildPages({ outputDir: process.argv[2] || '_site' });
    console.log(`网页版构建成功：${relative(root, result.outputDir)}，${result.files.length} 个文件，版本 ${result.version}。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
