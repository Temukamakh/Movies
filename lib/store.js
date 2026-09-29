import fs from 'node:fs';

/** A JSON file kept in memory and written back atomically shortly after each change. */
export class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    this.timer = null;
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, backup);
        console.warn(`Could not read ${file} (${err.message}); moved it to ${backup} and started fresh.`);
      }
    }
  }

  save() {
    this.timer ??= setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
