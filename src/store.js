import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Tiny durable JSON store. Writes are atomic (write temp file, then rename). */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { deals: {} };
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8'));
        this.data.deals ||= {};
      } catch {
        // A corrupt file should never take the app down; start fresh and keep the old one.
        renameSync(file, `${file}.corrupt-${Date.now()}`);
      }
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  getDeal(id) {
    return this.data.deals[id] || null;
  }

  listDeals() {
    return Object.values(this.data.deals).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  putDeal(deal) {
    deal.updatedAt = new Date().toISOString();
    this.data.deals[deal.id] = deal;
    this.save();
    return deal;
  }
}
