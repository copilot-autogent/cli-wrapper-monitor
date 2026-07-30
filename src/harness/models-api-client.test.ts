import { afterEach, describe, expect, it } from 'vitest';
import { hasGitHubToken } from './models-api-client.js';

const savedEnvironment = {
  models: process.env['MODELS_API_TOKEN'],
  github: process.env['GITHUB_TOKEN'],
  api: process.env['GITHUB_API_TOKEN'],
};

afterEach(() => {
  if (savedEnvironment.models === undefined) delete process.env['MODELS_API_TOKEN'];
  else process.env['MODELS_API_TOKEN'] = savedEnvironment.models;
  if (savedEnvironment.github === undefined) delete process.env['GITHUB_TOKEN'];
  else process.env['GITHUB_TOKEN'] = savedEnvironment.github;
  if (savedEnvironment.api === undefined) delete process.env['GITHUB_API_TOKEN'];
  else process.env['GITHUB_API_TOKEN'] = savedEnvironment.api;
});

describe('hasGitHubToken', () => {
  it('falls back to GITHUB_TOKEN when MODELS_API_TOKEN is absent', () => {
    delete process.env['MODELS_API_TOKEN'];
    delete process.env['GITHUB_API_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'github-token';

    expect(hasGitHubToken()).toBe(true);
  });
});
