import { cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Safari 27 local acceptance build. Core code is shared with the Chromium build.
// Safari's packager reports background.type and sidePanel/side_panel unsupported.
const output = path.resolve('release/HoriTieba-safari');
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
if (
  manifest.host_permissions.length !== 1 ||
  manifest.host_permissions[0] !== 'https://tieba.baidu.com/*'
) {
  throw Error('Safari build must retain the reviewed Tieba-only host scope');
}
delete manifest.minimum_chrome_version;
delete manifest.side_panel;
manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel');
delete manifest.background.type;
await mkdir(path.dirname(output), { recursive: true });
await rm(output, { recursive: true, force: true });
await cp('dist', output, { recursive: true });
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Safari 临时验收构建已生成：${output}`);
