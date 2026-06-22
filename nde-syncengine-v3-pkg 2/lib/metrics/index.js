'use strict';
/**
 * Prometheus metrics + health endpoint.
 * Runs on a sidecar HTTP server at PORT+1 (default 8091).
 * Only two routes: GET /health  and  GET /metrics
 */
const http = require('http');
const prom = require('prom-client');

const register = new prom.Registry();
prom.collectDefaultMetrics({ register });

const messagesIngested = new prom.Counter({
  name: 'nde_messages_ingested_total',
  help: 'Total messages ingested',
  registers: [register],
});

const framesSent = new prom.Counter({
  name: 'nde_frames_sent_total',
  help: 'Total frames sent to clients',
  labelNames: ['type'],
  registers: [register],
});

const errorsTotal = new prom.Counter({
  name: 'nde_errors_total',
  help: 'Total error frames sent',
  labelNames: ['code'],
  registers: [register],
});

const activeConns = new prom.Gauge({
  name: 'nde_active_connections',
  help: 'Current WebSocket connections',
  registers: [register],
});

const activeConvs = new prom.Gauge({
  name: 'nde_active_conversations',
  help: 'Conversations with at least one subscriber on this node',
  registers: [register],
});

const frameLatency = new prom.Histogram({
  name: 'nde_frame_processing_ms',
  help: 'Frame processing latency in ms',
  labelNames: ['type'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [register],
});

function startMetricsServer(port, redisClient, mongoClient) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    if (req.url === '/health') {
      try {
        await redisClient.ping();
        await mongoClient.db().command({ ping: 1 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: String(e.message) }));
      }
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(await register.metrics());
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(port, () => console.log(`[metrics] :${port}`));
  return server;
}

module.exports = { startMetricsServer, messagesIngested, framesSent, errorsTotal, activeConns, activeConvs, frameLatency };
