// Read and independently verify CRX3's documented protobuf envelope and ZIP.
// Format: chromium/components/crx_file/{crx3.proto,crx_verifier.cc}.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const sri = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
export function extensionId(publicKeyDER) {
  return createHash('sha256').update(publicKeyDER).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}
function varint(bytes, cursor) {
  let value = 0, scale = 1;
  for (let i = 0; i < 6 && cursor.at < bytes.length; i++) {
    const byte = bytes[cursor.at++]; value += (byte & 127) * scale;
    if (!(byte & 128)) return value;
    scale *= 128;
  }
  throw new Error('Invalid CRX protobuf varint');
}
function fields(bytes) {
  const result = new Map(), cursor = { at: 0 };
  while (cursor.at < bytes.length) {
    const tag = varint(bytes, cursor), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field) throw new Error('Invalid CRX protobuf field');
    if (wire === 0) { varint(bytes, cursor); continue; }
    if (wire !== 2) throw new Error('Unsupported CRX protobuf field');
    const length = varint(bytes, cursor);
    if (length > bytes.length - cursor.at) throw new Error('Truncated CRX protobuf field');
    const value = bytes.subarray(cursor.at, cursor.at + length); cursor.at += length;
    result.set(field, [...(result.get(field) || []), value]);
  }
  return result;
}
function one(fieldMap, field) {
  const values = fieldMap.get(field);
  if (!values || values.length !== 1) throw new Error('Missing or duplicate CRX field');
  return values[0];
}
export function verifyCRX(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'Cr24' || bytes.readUInt32LE(4) !== 3) throw new Error('Expected a CRX3 package');
  const headerLength = bytes.readUInt32LE(8);
  if (headerLength > 1024 * 1024 || headerLength > bytes.length - 12) throw new Error('Invalid CRX header length');
  const header = fields(bytes.subarray(12, 12 + headerLength));
  const signedHeader = one(header, 10000), crxId = one(fields(signedHeader), 1);
  if (crxId.length !== 16) throw new Error('Invalid CRX ID');
  const archive = bytes.subarray(12 + headerLength);
  if (archive.length < 4 || archive.readUInt32LE(0) !== 0x04034b50) throw new Error('CRX payload is not a ZIP archive');
  const size = Buffer.alloc(4); size.writeUInt32LE(signedHeader.length);
  const signed = Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signedHeader, archive]);
  for (const encoded of header.get(2) || []) {
    const proof = fields(encoded), publicKey = one(proof, 1), signature = one(proof, 2);
    if (!createHash('sha256').update(publicKey).digest().subarray(0,16).equals(crxId)) continue;
    const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || !verify('sha256', signed, key, signature)) throw new Error('CRX signature failed verification');
    return { id: extensionId(publicKey), publicKey, archive };
  }
  throw new Error('No RSA signing proof matches the CRX ID');
}
export function zipFiles(zip) {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65557); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) { end = at; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw new Error('Invalid or multipart ZIP');
  const count = zip.readUInt16LE(end + 10), directorySize = zip.readUInt32LE(end + 12);
  let cursor = zip.readUInt32LE(end + 16);
  if (count === 65535 || cursor + directorySize > end) throw new Error('Unsupported ZIP64 or invalid directory');
  const result = new Map();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20), size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28), extraLength = zip.readUInt16LE(cursor + 30), commentLength = zip.readUInt16LE(cursor + 32);
    const local = zip.readUInt32LE(cursor + 42), name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 1 || ![0,8].includes(method) || size > 16 * 1024 * 1024 || local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Unsupported or unsafe ZIP entry');
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..') || result.has(name)) throw new Error('Unsafe or duplicate ZIP path');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + compressedSize > zip.length) throw new Error('Truncated ZIP data');
    const compressed = zip.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: 16 * 1024 * 1024 });
    if (data.length !== size) throw new Error('ZIP size mismatch');
    if (!name.endsWith('/')) result.set(name, data);
  }
  return result;
}
export function inspectCRX(bytes) {
  const verified = verifyCRX(bytes), files = zipFiles(verified.archive);
  const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') || 'null');
  if (!manifest || manifest.manifest_version !== 3 || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error('Package manifest is invalid');
  if (manifest.key !== verified.publicKey.toString('base64')) throw new Error('Packaged manifest key does not match its signing key');
  return { ...verified, files, manifest, hash: sri(bytes) };
}
