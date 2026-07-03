import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Experiment, ExperimentResult, MetricSnapshot } from './types.js';
import { CURRENT_SCHEMA_VERSION } from './baseline-migrator.js';

export class ExperimentRunner {
  private readonly experiments: Experiment[] = [];

  register(experiment: Experiment): this {
    this.experiments.push(experiment);
    return this;
  }

  async runAll(): Promise<MetricSnapshot> {
    const results: Record<string, ExperimentResult> = {};

    for (const exp of this.experiments) {
      console.log(`  → Running: ${exp.name}`);
      try {
        results[exp.name] = await exp.run();
      } catch (err) {
        console.error(`    ✗ ${exp.name} failed: ${String(err)}`);
        results[exp.name] = {
          name: exp.name,
          description: exp.description,
          metrics: {},
          error: String(err),
        };
      }
    }

    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { dependencies?: Record<string, string> };

    let monitorVersion = 'unknown';
    try {
      monitorVersion = execSync('git rev-parse --short HEAD', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // not in a git repo or git not available
    }

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      capturedAt: new Date().toISOString(),
      monitorVersion,
      sdkVersion: pkg.dependencies?.['@github/copilot-sdk'] ?? 'unknown',
      model: process.env['AUTOGENT_MODEL'] ?? 'unknown',
      experiments: results,
    };
  }
}
