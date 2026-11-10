import { describe, expect, it } from 'vitest';
import { checkImage, configPath } from '../../scripts/check-image';

type Image = Parameters<typeof checkImage>[0] & {
  config: { Env: string[]; ExposedPorts: Record<string, unknown> };
};

const commit = '0123456789abcdef0123456789abcdef01234567';

const web = (): Image => ({
  architecture: 'amd64',
  os: 'linux',
  config: {
    User: 'node',
    WorkingDir: '/app',
    Cmd: ['node', 'server.js'],
    ExposedPorts: { '8080/tcp': {} },
    Env: [
      'PATH=/usr/local/bin:/usr/bin',
      'NODE_ENV=production',
      'PORT=8080',
      'HOSTNAME=0.0.0.0',
      `APP_COMMIT=${commit}`,
    ],
  },
});

describe('image tarball check', () => {
  it('finds the config named by a one-image manifest', () => {
    expect(configPath([{ Config: 'sha256:abc', Layers: [] }])).toBe('sha256:abc');
    expect(() => configPath([])).toThrow(/one image/);
    expect(() => configPath([{}, {}])).toThrow(/one image/);
    expect(() => configPath([{ Layers: [] }])).toThrow(/no config/);
  });

  it('passes the web image the build script makes', () => {
    expect(checkImage(web(), 'web', commit)).toEqual([]);
  });

  it.each([
    ['root user', (i: Image) => (i.config.User = 'root'), /user is root/],
    ['another workdir', (i: Image) => (i.config.WorkingDir = '/'), /workdir/],
    ['another platform', (i: Image) => (i.architecture = 'arm64'), /linux\/amd64/],
    ['another command', (i: Image) => (i.config.Cmd = ['sh']), /cmd/],
    ['no port', (i: Image) => (i.config.ExposedPorts = {}), /8080\/tcp/],
    ['an environment name', (i: Image) => i.config.Env.push('APP_ENV=test'), /APP_ENV is baked in/],
    ['another commit', (i: Image) => (i.config.Env[4] = 'APP_COMMIT=' + 'f'.repeat(40)), /APP_COMMIT/],
  ])('refuses an image with %s', (_label, change, problem) => {
    const image = web();
    change(image);
    expect(checkImage(image, 'web', commit).join('\n')).toMatch(problem);
  });

  it('refuses a web image when no commit is expected, and a placeholder that carries one', () => {
    expect(checkImage(web(), 'web').join('\n')).toMatch(/APP_COMMIT/);
    expect(checkImage(web(), 'live-placeholder')).toEqual(['the placeholder carries APP_COMMIT']);
  });

  it('passes the placeholder without a commit or hostname', () => {
    const image = web();
    image.config.Env = ['NODE_ENV=production', 'PORT=8080'];
    expect(checkImage(image, 'live-placeholder')).toEqual([]);
  });
});
