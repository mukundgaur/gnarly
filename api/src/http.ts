import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type Caller } from './model.ts';
import { PublishApi, type Deps } from './service.ts';

type Request = IncomingMessage & { body?: unknown };

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export function createHandler(deps: Deps & { trustProxy?: boolean; corsOrigins?: string[] }) {
  const api = new PublishApi(deps);
  const trustProxy = deps.trustProxy ?? (process.env.TRUST_PROXY === '1' || Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET));
  const corsOrigins = new Set(deps.corsOrigins ?? (process.env.GNARLY_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',').map(item => item.trim()).filter(Boolean));

  return async function handler(req: Request, res: ServerResponse) {
    const origin = header(req, 'origin');
    if (origin && corsOrigins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    try {
      if (req.method === 'OPTIONS') {
        if (origin && !corsOrigins.has(origin)) throw new ApiError(403, 'forbidden', 'This origin cannot call the publish API.');
        res.writeHead(204);
        res.end();
        return;
      }
      if (origin && !corsOrigins.has(origin)) throw new ApiError(403, 'forbidden', 'This origin cannot call the publish API.');
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        send(res, 200, { ok: true });
        return;
      }
      const caller = await authenticate(req, deps, trustProxy);
      const building = /^\/v1\/buildings\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (req.method === 'POST' && url.pathname === '/v1/buildings') {
        send(res, 200, await api.createBuilding(caller, await readJson(req)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/buildings') {
        send(res, 200, await api.listBuildings(caller));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/downloads') {
        send(res, 200, await api.signDownload(caller, await readJson(req)));
        return;
      }
      if (!building) throw new ApiError(404, 'not_found', 'Unknown publish API route.');
      const buildingId = decodeURIComponent(building[1]);
      const rest = building[2] ?? '';
      if (req.method === 'GET' && rest === 'package') {
        send(res, 200, await api.downloadPackage(caller, buildingId, url.searchParams));
        return;
      }
      const publish = /^publishes\/([^/]+)\/commit$/.exec(rest);
      if (req.method === 'POST' && rest === 'publishes') {
        send(res, 200, await api.startPublish(caller, buildingId, await readJson(req)));
        return;
      }
      if (req.method === 'POST' && publish) {
        send(res, 200, await api.commitPublish(caller, buildingId, decodeURIComponent(publish[1])));
        return;
      }
      throw new ApiError(404, 'not_found', 'Unknown publish API route.');
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 429 && typeof error.details.retryAfterSeconds === 'number') {
          res.setHeader('retry-after', String(error.details.retryAfterSeconds));
        }
        send(res, error.status, { error: { code: error.code, message: error.message, ...error.details } });
        return;
      }
      console.error(error);
      send(res, 500, { error: { code: 'internal', message: 'The publish API failed.' } });
    }
  };
}

async function authenticate(req: Request, deps: Deps, trustProxy: boolean): Promise<Caller> {
  const headerValue = header(req, 'authorization');
  const token = headerValue?.startsWith('Bearer ') ? headerValue.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in before publishing or downloading.');
  const user = await deps.verifyToken(token);
  if (!user.uid) throw new ApiError(401, 'unauthenticated', 'Sign in before publishing or downloading.');
  return { uid: user.uid, ip: clientIp(req, trustProxy) };
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const value = header(req, 'x-forwarded-for');
    const first = value?.split(',')[0]?.trim();
    if (first) return first.slice(0, 80);
  }
  return req.socket.remoteAddress || 'unknown';
}

async function readJson(req: Request): Promise<unknown> {
  if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));
  if (typeof req.body === 'string') return parseJson(req.body);
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw new ApiError(413, 'too_large', 'JSON body exceeds 1 MB.');
    chunks.push(bytes);
  }
  if (!size) return {};
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body is not JSON.');
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}
