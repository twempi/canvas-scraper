export class Selection {
  constructor(keys = []) { this.keys = new Set(keys); }
  set(key, selected) { selected ? this.keys.add(key) : this.keys.delete(key); }
  group(keys, selected) { keys.forEach(key => this.set(key, selected)); }
  state(keys) {
    const selected = keys.reduce((n,key) => n + Number(this.keys.has(key)), 0);
    return { checked: keys.length > 0 && selected === keys.length, indeterminate: selected > 0 && selected < keys.length, count: selected };
  }
  reconcile(valid) { this.keys = new Set([...this.keys].filter(k => valid.has(k))); }
}
