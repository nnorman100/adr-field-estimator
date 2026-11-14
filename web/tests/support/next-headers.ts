import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import { NodeNextRequest, NodeNextResponse } from 'next/dist/server/base-http/node';
import { sendResponse } from 'next/dist/server/send-response';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import nextConfig from '../../next.config';

// The headers a browser gets from the app at `path` when its route answers `answer`, read back over
// HTTP. As the running app does it: the header rules of next.config.ts, matched with Next's own
// matcher and options (next/dist/server/lib/router-utils/filesystem.js, buildCustomRoute), are set
// first, and then Next's own sendResponse sends the route's answer.
export async function servedHeaders(path: string, answer: Response): Promise<Headers> {
  const rules = (await nextConfig.headers!()).map((rule) => ({
    headers: rule.headers,
    match: getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (regex) => modifyRouteRegex(regex) }),
  }));
  const server = createServer((req, res) => {
    const pathname = new URL(req.url!, 'http://localhost').pathname;
    for (const rule of rules) if (rule.match(pathname)) for (const { key, value } of rule.headers) res.setHeader(key, value);
    void sendResponse(new NodeNextRequest(req), new NodeNextResponse(res), answer);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    await response.arrayBuffer();
    return response.headers;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
