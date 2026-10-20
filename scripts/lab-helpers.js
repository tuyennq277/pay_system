'use strict';

const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { createBankServer } = require('../src/bank');
const { createFeeServer } = require('../src/fee');

function seededRandom(seed = 20261020) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function createRequester() {
  // This is the load-generator -> Fee hop. Only Fee -> Bank pooling is under test.
  // Use fresh load-generator sockets to avoid a separate idle-close race at Fee.
  const agent = new http.Agent({ keepAlive: false, maxSockets: 30 });
  function request(url, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(url, { method, agent, headers: {
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), ms: performance.now() - start });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(20_000, () => req.destroy(new Error('Lab client timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  }
  return { request, close: () => agent.destroy() };
}

async function createLab({ bank = {}, fee = {}, bankRunning = true } = {}) {
  let bankServer = createBankServer({ logger: () => {}, random: seededRandom(), ...bank });
  const bankUrl = await listen(bankServer);
  const bankPort = bankServer.address().port;
  if (!bankRunning) await close(bankServer);
  const feeServer = createFeeServer({ ...fee, bankUrl });
  const feeUrl = await listen(feeServer);
  const client = createRequester();
  return {
    bankUrl, feeUrl, bankPort,
    request: client.request,
    pay: (amount = 1000, studentId = 1) => client.request(`${feeUrl}/students/${studentId}/payments`, {
      method: 'POST', body: { amount },
    }),
    fees: (studentId = 1) => client.request(`${feeUrl}/students/${studentId}/fees`),
    stats: () => client.request(`${bankUrl}/stats`),
    async stopBank() { await close(bankServer); },
    async startBank(config = bank) {
      bankServer = createBankServer({ logger: () => {}, random: seededRandom(), ...config });
      await listen(bankServer, bankPort);
    },
    async close() {
      client.close();
      await close(feeServer);
      await close(bankServer);
    },
  };
}

async function load(lab, count, concurrency = 1, amount = 1000) {
  const results = [];
  let cursor = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < count) {
      cursor += 1;
      results.push(await lab.pay(amount));
    }
  }));
  return {
    results, ms: performance.now() - start,
    paid: results.filter(result => result.body.status === 'PAID').length,
    pending: results.filter(result => result.body.status === 'PENDING').length,
    failed: results.filter(result => result.body.status === 'FAILED').length,
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = { createLab, createRequester, load, sleep, seededRandom, listen, close };
