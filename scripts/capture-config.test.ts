/**
 * Unit tests for capture-config.ts
 *
 * Tests config parsing, validation, default fallback, and directory routing.
 * Uses real temp files — no fs mocking required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadCaptureConfig,
  resolveBaselinesDir,
  DEFAULT_CONFIG,
  type CaptureConfig,
} from './capture-config.js';

// ---------------------------------------------------------------------------
// loadCaptureConfig
// ---------------------------------------------------------------------------

describe('loadCaptureConfig', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `capture-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, 'capture.config.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns DEFAULT_CONFIG when config file does not exist', () => {
    const cfg = loadCaptureConfig(join(tmpDir, 'nonexistent.json'));
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('parses a full valid config', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        monthlyBaselinesDir: 'captures/monthly',
        weeklyBaselinesDir: 'captures/weekly',
        retentionMonths: 12,
      }),
      'utf-8'
    );
    const cfg = loadCaptureConfig(configPath);
    expect(cfg.monthlyBaselinesDir).toBe('captures/monthly');
    expect(cfg.weeklyBaselinesDir).toBe('captures/weekly');
    expect(cfg.retentionMonths).toBe(12);
  });

  it('applies defaults for missing optional fields', () => {
    writeFileSync(configPath, JSON.stringify({ retentionMonths: 3 }), 'utf-8');
    const cfg = loadCaptureConfig(configPath);
    expect(cfg.monthlyBaselinesDir).toBe(DEFAULT_CONFIG.monthlyBaselinesDir);
    expect(cfg.weeklyBaselinesDir).toBe(DEFAULT_CONFIG.weeklyBaselinesDir);
    expect(cfg.retentionMonths).toBe(3);
  });

  it('ignores unknown keys', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ retentionMonths: 6, unknownKey: 'ignored' }),
      'utf-8'
    );
    const cfg = loadCaptureConfig(configPath);
    expect(cfg).not.toHaveProperty('unknownKey');
    expect(cfg.retentionMonths).toBe(6);
  });

  it('throws when the file is not valid JSON', () => {
    writeFileSync(configPath, '{not valid json}', 'utf-8');
    expect(() => loadCaptureConfig(configPath)).toThrow(/Failed to parse/);
  });

  it('throws when root value is not an object', () => {
    writeFileSync(configPath, '[1, 2, 3]', 'utf-8');
    expect(() => loadCaptureConfig(configPath)).toThrow(/root value must be a JSON object/);
  });

  it('throws when monthlyBaselinesDir is an empty string', () => {
    writeFileSync(configPath, JSON.stringify({ monthlyBaselinesDir: '  ' }), 'utf-8');
    expect(() => loadCaptureConfig(configPath)).toThrow(/monthlyBaselinesDir must be a non-empty string/);
  });

  it('throws when weeklyBaselinesDir is not a string', () => {
    writeFileSync(configPath, JSON.stringify({ weeklyBaselinesDir: 42 }), 'utf-8');
    expect(() => loadCaptureConfig(configPath)).toThrow(/weeklyBaselinesDir must be a non-empty string/);
  });

  it('throws when retentionMonths is zero', () => {
    writeFileSync(configPath, JSON.stringify({ retentionMonths: 0 }), 'utf-8');
    expect(() => loadCaptureConfig(configPath)).toThrow(/retentionMonths must be a positive integer/);
  });

  it('throws when retentionMonths is negative', () => {
    writeFileSync(configPath, JSON.stringify({ retentionMonths: -3 }), 'utf-8');
    expect(() => loadCaptureConfig(configPath)).toThrow(/retentionMonths must be a positive integer/);
  });

  it('throws when retentionMonths is a float', () => {
    writeFileSync(configPath, JSON.stringify({ retentionMonths: 1.5 }), 'utf-8');
    expect(() => loadCaptureConfig(configPath)).toThrow(/retentionMonths must be a positive integer/);
  });

  it('trims whitespace from directory paths', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ monthlyBaselinesDir: '  baselines  ', weeklyBaselinesDir: '  baselines/weekly  ' }),
      'utf-8'
    );
    const cfg = loadCaptureConfig(configPath);
    expect(cfg.monthlyBaselinesDir).toBe('baselines');
    expect(cfg.weeklyBaselinesDir).toBe('baselines/weekly');
  });

  it('does not mutate DEFAULT_CONFIG when returning defaults', () => {
    const before = { ...DEFAULT_CONFIG };
    loadCaptureConfig(join(tmpDir, 'nonexistent.json'));
    expect(DEFAULT_CONFIG).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// resolveBaselinesDir
// ---------------------------------------------------------------------------

describe('resolveBaselinesDir', () => {
  const customConfig: CaptureConfig = {
    monthlyBaselinesDir: 'captures/monthly',
    weeklyBaselinesDir: 'captures/weekly',
    retentionMonths: 6,
  };

  it('routes "weekly" to weeklyBaselinesDir', () => {
    expect(resolveBaselinesDir('weekly', customConfig)).toBe('captures/weekly');
  });

  it('routes "scheduled" to monthlyBaselinesDir', () => {
    expect(resolveBaselinesDir('scheduled', customConfig)).toBe('captures/monthly');
  });

  it('routes "manual" to monthlyBaselinesDir', () => {
    expect(resolveBaselinesDir('manual', customConfig)).toBe('captures/monthly');
  });

  it('routes "post-release" to monthlyBaselinesDir', () => {
    expect(resolveBaselinesDir('post-release', customConfig)).toBe('captures/monthly');
  });

  it('routes empty string to monthlyBaselinesDir', () => {
    expect(resolveBaselinesDir('', customConfig)).toBe('captures/monthly');
  });

  it('is case-insensitive for "weekly" (e.g. WEEKLY, Weekly)', () => {
    expect(resolveBaselinesDir('WEEKLY', customConfig)).toBe('captures/weekly');
    expect(resolveBaselinesDir('Weekly', customConfig)).toBe('captures/weekly');
  });

  it('trims whitespace before routing', () => {
    expect(resolveBaselinesDir('  weekly  ', customConfig)).toBe('captures/weekly');
  });

  it('uses DEFAULT_CONFIG when no config is passed', () => {
    expect(resolveBaselinesDir('weekly')).toBe(DEFAULT_CONFIG.weeklyBaselinesDir);
    expect(resolveBaselinesDir('manual')).toBe(DEFAULT_CONFIG.monthlyBaselinesDir);
  });
});

// ---------------------------------------------------------------------------
// capturePromptSectionText field
// ---------------------------------------------------------------------------

describe('capturePromptSectionText config field', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `capture-config-test-pst-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, 'capture.config.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults capturePromptSectionText to false when field absent', () => {
    writeFileSync(configPath, JSON.stringify({ retentionMonths: 3 }), 'utf-8');
    const cfg = loadCaptureConfig(configPath);
    expect(cfg.capturePromptSectionText).toBe(false);
  });

  it('DEFAULT_CONFIG has capturePromptSectionText=false', () => {
    expect(DEFAULT_CONFIG.capturePromptSectionText).toBe(false);
  });

  it('parses capturePromptSectionText=true', () => {
    writeFileSync(configPath, JSON.stringify({ capturePromptSectionText: true }), 'utf-8');
    const cfg = loadCaptureConfig(configPath);
    expect(cfg.capturePromptSectionText).toBe(true);
  });

  it('parses capturePromptSectionText=false', () => {
    writeFileSync(configPath, JSON.stringify({ capturePromptSectionText: false }), 'utf-8');
    const cfg = loadCaptureConfig(configPath);
    expect(cfg.capturePromptSectionText).toBe(false);
  });

  it('throws when capturePromptSectionText is not a boolean', () => {
    writeFileSync(configPath, JSON.stringify({ capturePromptSectionText: 'yes' }), 'utf-8');
    expect(() => loadCaptureConfig(configPath)).toThrow('capturePromptSectionText must be a boolean');
  });
});
