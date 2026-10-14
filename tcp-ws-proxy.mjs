import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';

const listenHost = process.env.LISTEN_HOST ?? (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const listenPort = Number(process.env.PORT ?? process.env.LISTEN_PORT ?? 443);
const targetHost = process.env.TARGET_HOST;
const targetPort = Number(process.env.TARGET_PORT);
const tlsKeyPath = process.env.TLS_KEY ?? './localhost-key.pem';
const tlsCertPath = process.env.TLS_CERT ?? './localhost-cert.pem';
const maxPayload = Number(process.env.MAX_WS_PAYLOAD ?? 1024 * 1024);
const RELAY_TOKEN = "MySecretAmongUsRelayToken2026!xYabc";
const isPublic = listenHost === '0.0.0.0' || listenHost === '::';
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
);

if (!targetHost || net.isIP(targetHost) === 0) {
  throw new Error('Set TARGET_HOST to the target server IP address.');
}
if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
  throw new Error('Set TARGET_PORT to a valid TCP port (1–65535).');
}
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('LISTEN_PORT must be a valid port (1–65535).');
}
if (!Number.isInteger(maxPayload) || maxPayload < 1) {
  throw new Error('MAX_WS_PAYLOAD must be a positive integer.');
}
if (isPublic && (!relayToken || relayToken.length < 32 || !/^[A-Za-z0-9_-]+$/.test(relayToken))) {
  throw new Error('Public mode requires RELAY_TOKEN with at least 32 URL-safe characters.');
}

// Render terminates public TLS at its edge and forwards HTTP/WebSocket upgrades
// to the service. Local runs terminate TLS here using the supplied certificate.
const server = process.env.RENDER
  ? http.createServer()
  : https.createServer({ key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath) });
const wss = new WebSocketServer({
  server,
  maxPayload,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }, done) => {
    if (!isAllowedWebOrigin(origin)) {
      done(false, 403, 'Origin is not allowed');
      return;
    }
    if (isPublic) {
      const offered = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',').map((protocol) => protocol.trim()).filter(Boolean);
      const presentedToken = offered.find((protocol) => protocol.startsWith('relay-auth-'))
        ?.slice('relay-auth-'.length);
      const expected = Buffer.from(relayToken);
      const presented = Buffer.from(presentedToken ?? '');
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        done(false, 401, 'Invalid relay token');
        return;
      }
    }
    done(true);
  },
  handleProtocols: (protocols) => [...protocols].find((protocol) => !protocol.startsWith('relay-auth-')) ?? '',
});

function isAllowedWebOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (allowedOrigins.has(parsed.origin)) return true;
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

wss.on('connection', (ws, request) => {
  const tcp = net.createConnection({ host: targetHost, port: targetPort });
  let ended = false;

  const closePair = (code = 1011, reason = 'TCP connection closed') => {
    if (ended) return;
    ended = true;
    tcp.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
    }
  };

  tcp.setNoDelay(true);
  tcp.on('connect', () => {
    console.log(`WebSocket ${request.socket.remoteAddress} connected to ${targetHost}:${targetPort}`);
  });

  // WebSocket messages become an unframed byte stream. TCP does not preserve
  // WebSocket message boundaries, and its response chunks become binary WS messages.
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      ws.close(1003, 'Binary WebSocket messages only');
      tcp.destroy();
      return;
    }
    if (!tcp.destroyed && !tcp.write(data)) ws._socket.pause();
  });

  tcp.on('drain', () => {
    if (ws.readyState === WebSocket.OPEN) ws._socket.resume();
  });

  tcp.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true }, (error) => {
      if (error) closePair();
      else if (ws.bufferedAmount > 0) tcp.pause();
      else tcp.resume();
    });
  });

  ws._socket.on('drain', () => tcp.resume());
  ws.on('close', () => {
    ended = true;
    tcp.end();
  });
  ws.on('error', () => closePair());
  tcp.on('end', () => {
    if (!ended && ws.readyState === WebSocket.OPEN) ws.close(1000, 'TCP peer ended');
  });
  tcp.on('error', (error) => {
    console.error(`TCP connection failed: ${error.message}`);
    closePair();
  });
});

wss.on('error', (error) => console.error(`WebSocket server error: ${error.message}`));
server.on('error', (error) => console.error(`HTTP server error: ${error.message}`));
server.listen(listenPort, listenHost, () => {
  console.log(`WebSocket TCP relay listening on ${listenHost}:${listenPort}`);
  console.log(`Forwarding binary payloads to ${targetHost}:${targetPort}`);
});
