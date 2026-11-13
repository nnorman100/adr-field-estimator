// Checks an image tarball that web/scripts/build-image.sh wrote, without a Docker daemon. The Web
// app workflow pipes the tarball's files in:
//
//   tar -xOf image.tar manifest.json | node scripts/check-image.ts config-path
//   tar -xOf image.tar <config path> | node scripts/check-image.ts web --commit <commit> --version <YYYY.MM.DD-N>
//   tar -xOf image.tar <config path> | node scripts/check-image.ts live-placeholder
//
// It refuses an image that would run as root, outside /app, on another platform or port, with
// another command, without its commit or release version, or with an environment name baked in (Cloud Run sets APP_ENV).
// Plain Node with type stripping; no installed packages.
import { pathToFileURL } from 'node:url';

type ImageConfig = {
  architecture?: string;
  os?: string;
  config?: {
    User?: string;
    WorkingDir?: string;
    Cmd?: string[];
    Env?: string[];
    ExposedPorts?: Record<string, unknown>;
  };
};

// The config file named by the tarball's manifest.json (one image per tarball).
export function configPath(manifest: unknown): string {
  if (!Array.isArray(manifest) || manifest.length !== 1) throw new Error('expected one image in the tarball');
  const config = (manifest[0] as { Config?: unknown }).Config;
  if (typeof config !== 'string' || config.length === 0) throw new Error('manifest names no config');
  return config;
}

// Returns one line per problem; an empty list means the image is fit to deploy.
export function checkImage(
  image: ImageConfig,
  app: 'web' | 'live-placeholder',
  commit?: string,
  version?: string,
): string[] {
  const problems: string[] = [];
  const c = image.config ?? {};
  const env = new Map((c.Env ?? []).map((pair) => [pair.split('=', 1)[0], pair.slice(pair.indexOf('=') + 1)]));
  if (image.os !== 'linux' || image.architecture !== 'amd64') {
    problems.push(`platform is ${image.os}/${image.architecture}, expected linux/amd64`);
  }
  if (c.User !== 'node') problems.push(`user is ${String(c.User)}, expected node`);
  if (c.WorkingDir !== '/app') problems.push(`workdir is ${String(c.WorkingDir)}, expected /app`);
  if (JSON.stringify(c.Cmd) !== JSON.stringify(['node', 'server.js'])) {
    problems.push(`cmd is ${JSON.stringify(c.Cmd)}, expected ["node","server.js"]`);
  }
  if (!c.ExposedPorts || !('8080/tcp' in c.ExposedPorts)) problems.push('port 8080/tcp is not exposed');
  if (env.get('PORT') !== '8080') problems.push(`PORT is ${String(env.get('PORT'))}, expected 8080`);
  if (env.get('NODE_ENV') !== 'production') problems.push('NODE_ENV is not production');
  if (env.has('APP_ENV')) problems.push('APP_ENV is baked in; Cloud Run must set it');
  if (app === 'web') {
    if (!commit || env.get('APP_COMMIT') !== commit) {
      problems.push(`APP_COMMIT is ${String(env.get('APP_COMMIT'))}, expected ${String(commit)}`);
    }
    if (!version || env.get('APP_VERSION') !== version) {
      problems.push(`APP_VERSION is ${String(env.get('APP_VERSION'))}, expected ${String(version)}`);
    }
    if (env.get('HOSTNAME') !== '0.0.0.0') problems.push('HOSTNAME is not 0.0.0.0');
  } else {
    if (env.has('APP_COMMIT')) problems.push('the placeholder carries APP_COMMIT');
    if (env.has('APP_VERSION')) problems.push('the placeholder carries APP_VERSION');
  }
  return problems;
}

async function main(argv: string[]) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const parsed: unknown = JSON.parse(input);
  const mode = argv[0];
  if (mode === 'config-path') {
    console.log(configPath(parsed));
    return;
  }
  if (mode !== 'web' && mode !== 'live-placeholder') throw new Error('mode must be config-path, web or live-placeholder');
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const problems = checkImage(parsed as ImageConfig, mode, flag('--commit'), flag('--version'));
  for (const problem of problems) console.error(`FAIL ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`image: ${mode} configuration ok`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'image check failed');
    process.exit(1);
  });
}
