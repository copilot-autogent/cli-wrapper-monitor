import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type { MetricSnapshot } from './types.js';

export class SnapshotStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Save a snapshot to disk.
   * Writes a timestamped file AND updates latest.json.
   * Returns the path to the timestamped file.
   */
  save(snapshot: MetricSnapshot): string {
    const safeTs = snapshot.capturedAt.replace(/[:.]/g, '-');
    const filename = `snapshot-${safeTs}.json`;
    const filePath = join(this.dir, filename);
    const json = JSON.stringify(snapshot, null, 2);

    writeFileSync(filePath, json, 'utf-8');
    writeFileSync(join(this.dir, 'latest.json'), json, 'utf-8');

    return filePath;
  }

  /** Load the most recently saved snapshot, or null if none exists. */
  loadLatest(): MetricSnapshot | null {
    const path = join(this.dir, 'latest.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as MetricSnapshot;
  }

  /** List all timestamped snapshot filenames, oldest first. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort();
  }
}
