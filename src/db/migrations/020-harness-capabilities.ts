import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'harness-capabilities',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN harness_capabilities TEXT NOT NULL DEFAULT '{}'").run();
  },
};
