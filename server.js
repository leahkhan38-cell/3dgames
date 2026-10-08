const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 3000);
const root = __dirname;
const openSkyUrl = 'https://opensky-network.org/api/states/all?extended=1';
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
let flightCache;

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function getFlights() {
  if (flightCache && Date.now() - flightCache.cachedAt < 8000) {
    return { status: 200, data: flightCache.data };
  }

  try {
    const upstream = await fetch(openSkyUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Flight-Radar-Dashboard/1.0',
      },
      signal: AbortSignal.timeout(7500),
    });
    if (!upstream.ok) {
      return {
        status: upstream.status === 401 || upstream.status === 403 || upstream.status === 429 ? upstream.status : 502,
        data: { error: `OpenSky Network returned HTTP ${upstream.status}.` },
      };
    }

    const payload = await upstream.json();
    const data = {
      time: Number.isFinite(payload.time) ? payload.time : Math.floor(Date.now() / 1000),
      states: Array.isArray(payload.states) ? payload.states : [],
    };
    data.total = data.states.length;
    flightCache = { data, cachedAt: Date.now() };
    return { status: 200, data };
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    return {
      status: 502,
      data: { error: timedOut ? 'OpenSky Network did not respond in time.' : 'Could not reach OpenSky Network.' },
    };
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return sendJson(response, 200, { status: 'ok' });
  }
  if (url.pathname === '/api/flights') {
    const result = await getFlights();
    return sendJson(response, result.status, result.data);
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  const filePath = path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Flight Radar running at http://localhost:${port}`);
});
