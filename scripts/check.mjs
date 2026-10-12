import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve('extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
if (manifest.manifest_version !== 3 || manifest.host_permissions.join() !== 'https://canvas.calpoly.edu/*' || manifest.action.default_popup) throw new Error('Manifest scope or full-tab action is invalid');
if (manifest.permissions.some(p=>!['scripting'].includes(p))) throw new Error('Unexpected permissions');
let count = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory,{ withFileTypes: true })) {
    const filename = path.join(directory,entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath,['--check',filename],{ encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      const source = fs.readFileSync(filename,'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const target = path.resolve(directory,match[1]);
        if (!target.startsWith(root + '/') || !fs.existsSync(target)) throw new Error(`Invalid local import in ${entry.name}`);
      }
      count++;
    } else if (entry.name.endsWith('.html')) {
      const source = fs.readFileSync(filename,'utf8');
      if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(source)) throw new Error(`Inline script in ${entry.name}`);
      for (const match of source.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        if (!match[1].includes('://') && !fs.existsSync(path.resolve(directory,match[1]))) throw new Error(`Missing asset ${match[1]}`);
      }
    }
  }
}
walk(root);
const id = createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
console.log(`Checked ${count} JS modules, manifest, imports, and local HTML assets. Extension ID: ${id}`);
