// Signing happens locally, outside Nix. Only the public signed package enters Nix.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extensionId, inspectCRX } from './crx.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { browser: process.env.CANVAS_ARCHIVE_BROWSER || 'helium', key: path.join(root, '.local/signing/canvas-local-archive.pem') };
for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i], value = process.argv[i+1];
  if (!['--browser','--key'].includes(option) || !value) throw new Error('Usage: npm run package:crx -- [--browser executable] [--key private-key.pem]');
  options[option.slice(2)] = value;
}
options.key = path.resolve(options.key);
const packages = path.join(root, 'packages'), releasePath = path.join(packages, 'release.json');
const old = fs.existsSync(releasePath) ? JSON.parse(fs.readFileSync(releasePath)) : null;
if (!fs.existsSync(options.key)) {
  if (old) throw new Error('Restore the existing signing key from backup before packaging. A new key would change the installed extension ID.');
  fs.mkdirSync(path.dirname(options.key), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(options.key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
}
const keyStat = fs.lstatSync(options.key);
if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.mode & 0o077) throw new Error('Signing key must be a regular private file with permissions 0600.');
const privateKey = createPrivateKey(fs.readFileSync(options.key));
if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('Expected an RSA signing key');
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const id = extensionId(publicKey);
if (old && old.id !== id) throw new Error('Signing key differs from the existing release. Restore the correct key to keep updates on the same ID.');

const source = path.join(root, 'extension'), sourceFiles = new Map();
function collect(directory, prefix = '') {
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name), relative = prefix + name, stat = fs.lstatSync(full);
    if (name.startsWith('.') || stat.isSymbolicLink()) throw new Error(`Do not package hidden files or symlinks: ${relative}`);
    if (stat.isDirectory()) collect(full, relative + '/');
    else {
      if (!stat.isFile() || !/\.(js|json|html|css|svg|png|jpg|webp|woff2)$/.test(name)) throw new Error(`Unexpected extension asset: ${relative}`);
      sourceFiles.set(relative, fs.readFileSync(full));
    }
  }
}
collect(source);
const manifest = JSON.parse(sourceFiles.get('manifest.json'));
const unpackedId = extensionId(Buffer.from(manifest.key, 'base64'));
manifest.key = publicKey.toString('base64');
if (manifest.update_url) throw new Error('This private local package must not declare a hosted update URL');
sourceFiles.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
const fingerprint = createHash('sha256');
for (const [name, bytes] of sourceFiles) fingerprint.update(name + '\0' + bytes.length + '\0').update(bytes);
const sourceHash = fingerprint.digest('hex'), version = manifest.version;
if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error('Invalid manifest version');
const filename = `${id}-${version}.crx`, destination = path.join(packages, filename);
let packageBytes;
if (old?.version === version) {
  if (old.sourceHash !== sourceHash) throw new Error('Extension assets changed without a version bump. Increase extension/manifest.json version before packaging an update.');
  packageBytes = fs.readFileSync(destination);
  if (inspectCRX(packageBytes).hash !== old.hash) throw new Error('Existing release was changed or corrupted. Restore the released package.');
} else {
  if (old && compareVersions(version, old.version) <= 0) throw new Error('Package update version must be greater than the previous release');
  fs.mkdirSync(path.join(root, '.local'), { recursive: true });
  const work = fs.mkdtempSync(path.join(root, '.local/crx-build-')), staged = path.join(work, 'extension');
  fs.mkdirSync(staged);
  for (const [name, bytes] of sourceFiles) {
    const target = path.join(staged, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  const result = spawnSync(options.browser, [
    `--pack-extension=${staged}`, `--pack-extension-key=${options.key}`,
    `--user-data-dir=${path.join(work, 'empty-profile')}`, '--no-first-run', '--no-default-browser-check'
  ], { encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0 || !fs.existsSync(staged + '.crx')) throw new Error('Helium packaging failed. Check the browser executable; no normal profile was used.');
  packageBytes = fs.readFileSync(staged + '.crx');
}
const inspected = inspectCRX(packageBytes);
if (inspected.id !== id || inspected.manifest.version !== version || inspected.files.size !== sourceFiles.size) throw new Error('Package identity, version, or file count differs from source');
for (const [name, expected] of sourceFiles) if (!inspected.files.get(name)?.equals(expected)) throw new Error(`Package differs from source: ${name}`);
if (old?.version !== version) {
  // Publish only a package that passed signature and exact-source checks.
  fs.mkdirSync(packages, { recursive: true });
  fs.writeFileSync(destination, packageBytes, { flag: 'wx' });
}
const release = { id, version, hash: inspected.hash, file: filename, sourceHash, unpackedId, format: 'CRX3' };
fs.writeFileSync(releasePath, JSON.stringify(release, null, 2) + '\n');
fs.writeFileSync(path.join(packages, 'registry.nix'), `# Generated by npm run package:crx. Public artifacts only.\n{\n  "${id}" = {\n    file = ./${filename};\n    version = "${version}";\n  };\n}\n`);
fs.writeFileSync(path.join(packages, 'entry.nix'), `# Canvas Local Archive — private signed package\n{\n  id = "${id}";\n  hash = "${inspected.hash}";\n}\n`);
console.log(`Verified signed CRX3: packages/${filename}\nVersion: ${version}\nID: ${id}\nHash: ${inspected.hash}\nSigning key is private and remains outside the package/Nix store. Back it up for updates.`);

function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) { const difference = (left[i] || 0) - (right[i] || 0); if (difference) return difference; }
  return 0;
}
