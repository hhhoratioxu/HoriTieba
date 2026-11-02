import { mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const release = path.resolve('release');
function releaseLinks(markdown) {
  return markdown
    .replaceAll('](chrome.md)', '](CHROME-安装与验收.md)')
    .replaceAll('](safari.md)', '](SAFARI-安装与验收.md)')
    .replaceAll('](test-report.md)', '](TEST-REPORT.md)')
    .replaceAll('](verification.md)', '](REAL-VERIFICATION.md)');
}
await mkdir(release, { recursive: true });
await readFile('dist/manifest.json');
const e2e = JSON.parse(await readFile('artifacts/e2e-results.json', 'utf8'));
const single = JSON.parse(await readFile('artifacts/thread-reply-e2e.json', 'utf8'));
const real = JSON.parse(await readFile('artifacts/real-e2e-results.json', 'utf8'));
if (
  !single.passed ||
  e2e.error ||
  real.error ||
  !e2e.results.length ||
  !real.results.length ||
  [...e2e.results, ...real.results].some((r) => r.status !== 'passed')
)
  throw Error('请先通过完整扩展测试再打包');
const extension = path.join(release, 'HoriTieba-extension');
async function sameFiles(left, right) {
  try {
    const a = await readdir(left, { withFileTypes: true });
    const b = await readdir(right, { withFileTypes: true });
    if (a.length !== b.length) return false;
    for (const item of a) {
      const other = b.find((entry) => entry.name === item.name);
      if (!other || item.isDirectory() !== other.isDirectory()) return false;
      const x = path.join(left, item.name),
        y = path.join(right, item.name);
      if (item.isDirectory()) {
        if (!(await sameFiles(x, y))) return false;
      } else if (!(await readFile(x)).equals(await readFile(y))) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
// Documentation-only repackaging must not replace a directory already loaded by Chrome.
if (!(await sameFiles('dist', extension))) {
  await rm(extension, { recursive: true, force: true });
  await cp('dist', extension, { recursive: true });
} else console.log('扩展代码未变化，保留已安装目录，仅重新生成交付归档');
await import('./build-safari.mjs');
await writeFile(
  path.join(release, 'README-安装与使用.md'),
  '# HoriTieba · 贴吧追评助手 0.3.0\n\n打开一篇贴吧帖子，在页面底部输入你想回复的内容，点「开始」。助手会逐条回复楼层和楼中楼。点「停止」或关闭这篇帖子即可结束。\n\n' +
    releaseLinks(await readFile('docs/installation.md', 'utf8')) +
    '\n\n---\n\n' +
    releaseLinks(await readFile('docs/user-guide.md', 'utf8')),
);
for (const [input, output] of [
  ['test-report.md', 'TEST-REPORT.md'],
  ['known-limitations.md', 'KNOWN-LIMITATIONS.md'],
  ['verification.md', 'REAL-VERIFICATION.md'],
  ['chrome.md', 'CHROME-安装与验收.md'],
  ['safari.md', 'SAFARI-安装与验收.md'],
])
  await writeFile(
    path.join(release, output),
    releaseLinks(await readFile(`docs/${input}`, 'utf8')),
  );
await cp('docs/evidence', path.join(release, 'evidence'), { recursive: true });
await cp('docs/images', path.join(release, 'images'), { recursive: true });
await cp('artifacts/screenshots', path.join(release, 'screenshots'), {
  recursive: true,
  filter: (s) => !s.endsWith('failure.png'),
});
const staging = path.join(release, '.source-staging');
await rm(staging, { recursive: true, force: true });
const source = path.join(staging, 'HoriTieba-source');
await mkdir(source, { recursive: true });
for (const file of [
  'src',
  'tests',
  'scripts',
  'docs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'manifest.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'dashboard.html',
  'sidepanel.html',
  'popup.html',
  'README.md',
  '.gitignore',
  '.prettierrc.json',
  '.prettierignore',
])
  await cp(file, path.join(source, file), { recursive: true });
function zip(input, filename) {
  const out = spawnSync('python3', ['scripts/archive.py', input, path.join(release, filename)], {
    encoding: 'utf8',
  });
  if (out.status !== 0) throw Error(out.stderr || 'ZIP 打包需要 Python 3');
}
zip(extension, 'HoriTieba-extension.zip');
zip(path.join(release, 'HoriTieba-safari'), 'HoriTieba-safari.zip');
zip(source, 'HoriTieba-source.zip');
await rm(staging, { recursive: true, force: true });
const checksums = [];
for (const name of ['HoriTieba-extension.zip', 'HoriTieba-safari.zip', 'HoriTieba-source.zip']) {
  const bytes = await readFile(path.join(release, name));
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await writeFile(path.join(release, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log(`交付目录：${release}\n${checksums.join('\n')}`);
