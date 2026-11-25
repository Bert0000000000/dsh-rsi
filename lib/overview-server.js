/**
 * RSI overview — Host plugin.
 *
 * Serves one read-only JSON route to this plugin's Client half. The Client has
 * no generic RPC gateway to the Host, so the route is the only channel; it
 * exposes nothing but the overview payload built by `lib/overview.js`, and it
 * accepts no command, no mutation and no path outside the resolved workspace.
 */

import { readGlobalOverview, readOverview, resolveWorkspace, syncGlobalLedger } from './overview.js';

const API_PREFIX = '/rsi-overview/api';
const MAX_CANDIDATES = 32;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Write a JSON response with the no-store headers a live view needs. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
    sendJson(res, 500, { error: 'payload-too-large' });
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/** Read a small JSON request body; returns null when it is absent or invalid. */
async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** Collect the Client's workspace hints from the query string. */
function workspaceCandidates(url) {
  const candidates = url.searchParams.getAll('cwd');
  const extra = url.searchParams.get('workspace');
  if (typeof extra === 'string' && extra) candidates.push(extra);
  return candidates.filter((value) => typeof value === 'string' && value.length > 0).slice(0, MAX_CANDIDATES);
}

/**
 * Host-side fallbacks for the Client's hints. Only the deployment default and
 * the registered workspaces are consulted, and `resolveWorkspace` still drops
 * anything that is not an existing absolute directory holding `.rsi`.
 */
function hostCandidates(ctx) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && value.length <= 400) out.push(value);
  };
  for (const serviceName of ['workingDirectory', 'workspaces', 'workspaceRegistry']) {
    let service = null;
    try {
      service = typeof ctx.get === 'function' ? ctx.get(serviceName) : null;
    } catch {
      service = null;
    }
    if (!service) continue;
    push(service.defaultDirectory);
    push(service.cwd);
    push(service.directory);
    for (const accessor of ['current', 'getCurrent', 'default']) {
      try {
        const value = service[accessor];
        push(typeof value === 'function' ? value.call(service) : value);
      } catch {
        /* an accessor that needs arguments cannot name the default workspace */
      }
    }
    for (const accessor of ['list', 'all', 'values']) {
      try {
        const value = service[accessor];
        if (typeof value !== 'function') continue;
        const entries = value.call(service);
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry === 'string') push(entry);
          else if (entry && typeof entry === 'object') push(entry.path ?? entry.directory ?? entry.cwd);
        }
      } catch {
        /* a workspace list that is not readable here simply contributes nothing */
      }
    }
  }
  push(process.cwd());
  return out;
}

export function registerOverview(ctx) {
  // Headless profiles and unit-test mocks may have no HTTP service at all.
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webContext) => {
    const webServer = webContext.webServer;
    if (!webServer || typeof webServer.register !== 'function') return;

    webContext.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          auth: 'required',
          handler: async (req, res) => {
            try {
              const url = new URL(req.url ?? API_PREFIX, 'http://localhost');
              const route = url.pathname.slice(API_PREFIX.length) || '/';
              if (route === '/sync') {
                if (req.method !== 'POST') {
                  res.setHeader('Allow', 'POST');
                  sendJson(res, 405, { error: 'method-not-allowed' });
                  return;
                }
                const body = await readJsonBody(req, 256 * 1024);
                if (!body || !Array.isArray(body.workspaces)) {
                  sendJson(res, 400, { error: 'bad-request', message: 'workspaces must be an array' });
                  return;
                }
                const result = await syncGlobalLedger(body.workspaces.slice(0, MAX_CANDIDATES));
                sendJson(res, 200, result);
                return;
              }
              if (route !== '/' && route !== '/overview') {
                sendJson(res, 404, { error: 'not-found' });
                return;
              }
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.setHeader('Allow', 'GET, HEAD');
                sendJson(res, 405, { error: 'method-not-allowed' });
                return;
              }

              const candidates = [...workspaceCandidates(url), ...hostCandidates(ctx)];
              if (url.searchParams.get('scope') === 'global') {
                const overview = await readGlobalOverview(candidates);
                overview.resolution = {
                  scope: 'global',
                  tried: overview.resolution.tried.slice(0, MAX_CANDIDATES + 8),
                };
                sendJson(res, 200, overview);
                return;
              }

              const resolved = await resolveWorkspace(candidates);
              const overview = await readOverview(resolved.workspace);
              overview.resolution = {
                via: resolved.via,
                tried: resolved.tried.slice(0, MAX_CANDIDATES + 4),
              };
              sendJson(res, 200, overview);
            } catch (error) {
              sendJson(res, 500, {
                error: 'overview-failed',
                message: error instanceof Error ? error.message : String(error),
              });
            }
          },
        }),
      'rsi-overview: read-only HTTP route',
    );
  });
}
