// Contract mock: models commit-on-close and abort. It does not prove browser APIs.
export class Directory {
  constructor(name = 'Course root', root = null) { this.name=name; this.kind='directory'; this.children=new Map(); this.root=root || this; this.root.access ||= 'granted'; }
  allowed() { if (this.root.access !== 'granted') throw new DOMException('Permission revoked','NotAllowedError'); }
  async queryPermission() { return this.root.access; }
  async requestPermission() { this.root.access = this.root.renewTo || 'granted'; return this.root.access; }
  async isSameEntry(other) { return this === other; }
  async getDirectoryHandle(name,{create=false}={}) {
    this.allowed(); let child = this.children.get(name);
    if (!child && create) { child = new Directory(name,this.root); this.children.set(name,child); }
    if (!child) throw new DOMException('Missing','NotFoundError');
    if (child.kind !== 'directory') throw new DOMException('Not a directory','TypeMismatchError');
    return child;
  }
  async getFileHandle(name,{create=false}={}) {
    this.allowed(); let child = this.children.get(name);
    if (!child && create) { child = new DiskFile(name,this.root); this.children.set(name,child); }
    if (!child) throw new DOMException('Missing','NotFoundError');
    if (child.kind !== 'file') throw new DOMException('Not a file','TypeMismatchError');
    return child;
  }
}
export class DiskFile {
  constructor(name,root) { this.name=name;this.kind='file';this.root=root;this.bytes=new Uint8Array();this.modified=1;this.writers=0;this.abortCount=0; }
  async getFile() { this.root.allowed(); return new File([this.bytes],this.name,{lastModified:this.modified}); }
  async isSameEntry(other) { return this === other; }
  set(value) { this.bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value); this.modified++; }
  async createWritable(options) {
    this.root.allowed(); if (options?.mode === 'exclusive' && this.writers) throw new DOMException('Writer locked','NoModificationAllowedError');
    this.writers++; const file=this, parts=[]; let done=false;
    return {
      async write(value) {
        file.root.allowed(); if (done) throw new Error('Closed');
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value);
        parts.push(bytes); await file.root.onWrite?.(file,bytes);
      },
      async close() {
        file.root.allowed(); if (done) throw new Error('Closed');
        file.set(new Uint8Array(await new Blob(parts).arrayBuffer())); done=true;file.writers--;
      },
      async abort() { if (!done) { done=true;file.abortCount++;file.writers--; } }
    };
  }
}
export async function put(root,path,value) {
  const parts=path.split('/'); let directory=root;
  for (const part of parts.slice(0,-1)) directory=await directory.getDirectoryHandle(part,{create:true});
  const file=await directory.getFileHandle(parts.at(-1),{create:true}); file.set(value); return file;
}
export async function read(root,path) {
  const parts=path.split('/');let directory=root;
  for (const part of parts.slice(0,-1)) directory=await directory.getDirectoryHandle(part);
  return (await (await directory.getFileHandle(parts.at(-1))).getFile()).text();
}
