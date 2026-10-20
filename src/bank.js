'use strict';

const http = require('node:http');
const express = require('express');
const { bankConfig } = require('./config');

function createBankServer({ delayMs = 0, failRate = 0, dropRate = 0, random = Math.random, logger = console.log } = {}) {
  const app = express();
  const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
  const byKey = new Map();
  const byReference = new Map();
  const debitCounts = new Map();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/', (req, res) => res.type('html').send(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ngân hàng giả lập</title></head>
<body><h1>Ngân hàng giả lập</h1><p>Service đang chạy.</p>
<p><a href="/stats">Xem thống kê ngân hàng</a></p>
<p>API trừ tiền: <code>POST /charges</code>, header <code>Content-Type: application/json</code>
và <code>Idempotency-Key: demo-P1</code>, body:</p>
<pre>{"reference":"demo-P1","amount":100000}</pre>
<p>Fee Service sẽ gọi API này khi bạn tạo lệnh thanh toán học phí.</p></body></html>`));

  app.get('/stats', (req, res) => res.json({ ...stats }));

  function replayOrConflict(key, reference, amount, res) {
    const existing = byKey.get(key);
    if (existing) {
      if (existing.reference !== reference || existing.amount !== amount) {
        res.status(409).json({ error: 'Idempotency-Key was already used with a different payload' });
      } else {
        res.status(201).json(existing);
      }
      return true;
    }
    if (byReference.has(reference)) {
      // A different key cannot debit an existing payment reference again.
      res.status(409).json({ error: 'Reference already charged with a different Idempotency-Key' });
      return true;
    }
    return false;
  }

  app.post('/charges', async (req, res) => {
    stats.requests += 1;
    const { reference, amount } = req.body || {};
    const key = req.get('Idempotency-Key');
    if (typeof reference !== 'string' || !reference.trim() || !key || !key.trim()
        || !Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A reference, Idempotency-Key and positive integer amount are required' });
    }
    if (replayOrConflict(key, reference, amount, res)) return;
    if (amount > 20_000_000) return res.status(402).json({ error: 'Charge exceeds the 20,000,000 VND limit' });

    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    // Another concurrent request may have committed while this request was delayed.
    if (replayOrConflict(key, reference, amount, res)) return;
    if (random() < failRate) return res.status(500).json({ error: 'Temporary bank failure before debit' });

    const charge = { chargeId: `C${stats.charges + 1}`, reference, amount, status: 'SUCCEEDED' };
    // No await between deduplication and commit: this is atomic in this Node process.
    byKey.set(key, charge);
    byReference.set(reference, charge);
    const count = (debitCounts.get(reference) || 0) + 1;
    debitCounts.set(reference, count);
    if (count > 1) stats.duplicates += 1;
    stats.charges += 1;

    if (random() < dropRate) return res.socket?.destroy();
    return res.status(201).json(charge);
  });

  app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid JSON request body' });
  });

  const server = http.createServer(app);
  server.keepAliveTimeout = 5000;
  // Newer Node releases add a grace buffer. Use precisely 5 s for this lab.
  if ('keepAliveTimeoutBuffer' in server) server.keepAliveTimeoutBuffer = 0;
  server.headersTimeout = 10_000;
  server.on('connection', socket => {
    stats.connections += 1;
    logger(`[bank] TCP connection #${stats.connections} from ${socket.remoteAddress}:${socket.remotePort}`);
  });
  return server;
}

if (require.main === module) {
  const { port, ...config } = bankConfig();
  const server = createBankServer(config);
  server.listen(port, () => console.log(`[bank] Listening on http://localhost:${port}`));
  server.on('error', error => { console.error(`[bank] ${error.message}`); process.exitCode = 1; });
}

module.exports = { createBankServer };
