import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
await viteBuild();
await build({
  entryPoints: ['src/background/entry.ts'],
  outfile: 'dist/background.js',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  legalComments: 'none',
});
await build({
  entryPoints: ['src/content/entry.ts'],
  outfile: 'dist/content.js',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
  minify: true,
});
await copyFile('manifest.json', 'dist/manifest.json');
const licenses = [];
for (const name of ['react', 'react-dom', 'zod', 'idb', 'lucide-react']) {
  const license = await readFile(`node_modules/${name}/LICENSE`, 'utf8').catch(async () =>
    readFile(`node_modules/${name}/LICENSE.md`, 'utf8'),
  );
  licenses.push(`----- ${name} -----\n${license}`);
}
await writeFile('dist/THIRD-PARTY-LICENSES.txt', licenses.join('\n\n'));
await mkdir('dist/icons', { recursive: true });
const crc = (b) => {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type),
    n = Buffer.alloc(4),
    c = Buffer.alloc(4);
  n.writeUInt32BE(data.length);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([n, t, data, c]);
};
for (const size of [16, 48, 128]) {
  const data = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const a = x / size,
        b = y / size;
      const outside =
        (a < 0.14 && b < 0.14 && Math.hypot(a - 0.14, b - 0.14) > 0.14) ||
        (a > 0.86 && b < 0.14 && Math.hypot(a - 0.86, b - 0.14) > 0.14) ||
        (a < 0.14 && b > 0.86 && Math.hypot(a - 0.14, b - 0.86) > 0.14) ||
        (a > 0.86 && b > 0.86 && Math.hypot(a - 0.86, b - 0.86) > 0.14);
      const h =
        (((a > 0.25 && a < 0.36) || (a > 0.64 && a < 0.75)) && b > 0.23 && b < 0.77) ||
        (a > 0.3 && a < 0.7 && b > 0.45 && b < 0.55);
      data[i] = h ? 255 : 121;
      data[i + 1] = h ? 255 : 99;
      data[i + 2] = h ? 255 : 220;
      data[i + 3] = outside ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    `dist/icons/icon${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(data)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
if (
  manifest.host_permissions.join() !== 'https://tieba.baidu.com/*' ||
  manifest.permissions.includes('cookies')
)
  throw Error('权限检查失败');
console.log('HoriTieba 构建完成：dist/（无需本地服务器）');
