// A switchable network in front of the app and both emulators (S6-1), so a test can cut the
// network for a page, its service worker and Firestore alike, and bring it back.
//
// Why not `context.setOffline`: Playwright documents routing of a service worker's requests for
// Chromium only, so a cut made there never reaches the worker in WebKit. A cut made here is a
// real refused or dropped connection, seen the same way by every client of the lane.
//
// One lane is one test's own set of three local ports (the app, the Auth emulator, the Firestore
// emulator), so tests running in parallel never cut each other off. Each port forwards, byte for
// byte, to the shared server behind it. The app port is also the origin the test page is served
// from, so cutting it takes the page itself away.
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { AUTH_EMULATOR_HOST } from '../sign-in/emulator';
import { E2E_EMU } from '../emu-ports';
import { FIRESTORE_EMULATOR_HOST } from './emulators';

export type Target = 'app' | 'auth' | 'firestore';
export const TARGETS: readonly Target[] = ['app', 'auth', 'firestore'];
const LOOPBACK = '127.0.0.1';
export const APP_PORT = E2E_EMU.ports.app;

function split(host: string): { host: string; port: number } {
  const [name, port] = host.split(':');
  return { host: name!, port: Number(port) };
}

type Side = {
  server: Server | HttpServer;
  port: number;
  sockets: Set<Socket>;
  // Connections that arrived while this side was cut.
  refused: number;
  // Bytes that went through in each direction, so a test can see that traffic stopped.
  bytes: number;
};

// `status` is 200 unless set: a test can stand in for one API answer (S6-3's GET /api/me).
export type StaticFile = { type: string; body: string | Buffer; status?: number };
// An answer worked out per request, from the request's headers.
export type Responder = (headers: IncomingHttpHeaders) => Promise<StaticFile>;

export class NetworkLane {
  private readonly sides = new Map<Target, Side>();
  private readonly cuts = new Set<Target>();
  private readonly bytesAtCut = new Map<Target, number>();
  private statics = new Map<string, StaticFile | Responder>();
  // Paths (and everything under a path ending in "/") the app side answers 404 to, as a server does
  // for files a newer build no longer has.
  private gone: string[] = [];

  private constructor() {}

  static async open(options: { statics?: Record<string, StaticFile> } = {}): Promise<NetworkLane> {
    const lane = new NetworkLane();
    lane.statics = new Map(Object.entries(options.statics ?? {}));
    await Promise.all([
      lane.listenApp(),
      lane.listenTcp('auth', split(AUTH_EMULATOR_HOST)),
      lane.listenTcp('firestore', split(FIRESTORE_EMULATOR_HOST)),
    ]);
    return lane;
  }

  get appUrl(): string {
    return `http://${LOOPBACK}:${this.side('app').port}`;
  }
  get authHost(): string {
    return `${LOOPBACK}:${this.side('auth').port}`;
  }
  get firestoreHost(): string {
    return `${LOOPBACK}:${this.side('firestore').port}`;
  }

  // What the server hands the browser as settings (parseBrowserSignInConfig reads these names).
  get env(): Record<string, string> {
    return { FIREBASE_AUTH_EMULATOR_HOST: this.authHost, FIRESTORE_EMULATOR_HOST: this.firestoreHost };
  }

  // Serves `file` at `path` from now on instead of the app's own answer: a deployment that changed
  // that file. Used by the worker tests (S6-2); restore with unserve().
  serve(path: string, file: StaticFile | Responder): void {
    this.statics.set(path, file);
  }

  unserve(path: string): void {
    this.statics.delete(path);
  }

  // Answers 404 for these paths from now on (a path ending in "/" covers everything under it): the
  // files an older build had and a newer deployment dropped.
  drop(...paths: string[]): void {
    this.gone.push(...paths);
  }

  isCut(target: Target): boolean {
    return this.cuts.has(target);
  }

  // Cuts the network for these targets (all of them by default), as when a phone loses its radio:
  // every open connection is torn down now, and a new one is refused until restore().
  cut(targets: readonly Target[] = TARGETS): void {
    for (const target of targets) {
      this.cuts.add(target);
      const side = this.side(target);
      this.bytesAtCut.set(target, side.bytes);
      for (const socket of [...side.sockets]) socket.resetAndDestroy();
      side.sockets.clear();
    }
  }

  restore(targets: readonly Target[] = TARGETS): void {
    for (const target of targets) this.cuts.delete(target);
  }

  // Connections that reached this side while it was cut.
  refused(target: Target): number {
    return this.side(target).refused;
  }

  // Bytes forwarded so far in both directions.
  bytes(target: Target): number {
    return this.side(target).bytes;
  }

  // Bytes forwarded since this side was last cut (0 while it holds); null when it is not cut.
  bytesSinceCut(target: Target): number | null {
    const at = this.bytesAtCut.get(target);
    return this.cuts.has(target) && at !== undefined ? this.side(target).bytes - at : null;
  }

  async close(): Promise<void> {
    for (const side of this.sides.values()) {
      for (const socket of side.sockets) socket.destroy();
      await new Promise<void>((done) => side.server.close(() => done()));
    }
    this.sides.clear();
  }

  private side(target: Target): Side {
    const side = this.sides.get(target);
    if (!side) throw new Error(`lane has no ${target}`);
    return side;
  }

  // Applies a cut to a connection that has just arrived. True when the caller must not forward it.
  private arrival(target: Target, socket: Socket, side: Side): boolean {
    if (!this.cuts.has(target)) return false;
    side.refused += 1;
    socket.resetAndDestroy();
    return true;
  }

  private listenTcp(target: Target, upstream: { host: string; port: number }): Promise<void> {
    const side: Side = { server: undefined as unknown as Server, port: 0, sockets: new Set(), refused: 0, bytes: 0 };
    const server = createTcpServer((client) => {
      if (this.arrival(target, client, side)) return;
      const behind = connect(upstream.port, upstream.host);
      side.sockets.add(client);
      side.sockets.add(behind);
      const forward = (from: Socket, to: Socket) => {
        from.on('data', (chunk) => {
          side.bytes += chunk.length;
          to.write(chunk);
        });
        from.on('end', () => to.end());
        from.on('error', () => to.destroy());
        from.on('close', () => {
          side.sockets.delete(from);
          to.destroy();
        });
      };
      forward(client, behind);
      forward(behind, client);
    });
    side.server = server;
    this.sides.set(target, side);
    return new Promise((done) => {
      server.listen(0, LOOPBACK, () => {
        side.port = (server.address() as AddressInfo).port;
        done();
      });
    });
  }

  // The app side is HTTP so it can serve the test page itself; everything else goes to the app.
  private listenApp(): Promise<void> {
    const side: Side = { server: undefined as unknown as HttpServer, port: 0, sockets: new Set(), refused: 0, bytes: 0 };
    const server = createHttpServer((req, res) => {
      const own = this.statics.get(new URL(req.url ?? '/', 'http://lane').pathname);
      if (own) {
        const send = (file: StaticFile) => {
          res.writeHead(file.status ?? 200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' });
          res.end(file.body);
        };
        if (typeof own === 'function') own(req.headers).then(send, () => res.destroy());
        else send(own);
        return;
      }
      const path = new URL(req.url ?? '/', 'http://lane').pathname;
      if (this.gone.some((gone) => (gone.endsWith('/') ? path.startsWith(gone) : path === gone))) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('gone');
        return;
      }
      const forwarded = httpRequest(
        { host: 'localhost', port: APP_PORT, method: req.method, path: req.url, headers: req.headers },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.on('data', (chunk: Buffer) => (side.bytes += chunk.length));
          answer.pipe(res);
        },
      );
      forwarded.on('error', () => res.destroy());
      req.pipe(forwarded);
    });
    server.on('connection', (socket) => {
      if (this.arrival('app', socket, side)) return;
      side.sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => side.sockets.delete(socket));
    });
    side.server = server;
    this.sides.set('app', side);
    return new Promise((done) => {
      server.listen(0, LOOPBACK, () => {
        side.port = (server.address() as AddressInfo).port;
        done();
      });
    });
  }
}
