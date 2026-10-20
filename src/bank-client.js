'use strict';

const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

class BankError extends Error {
  constructor(message, httpStatus, status, details = {}) {
    super(message);
    this.httpStatus = httpStatus;
    this.paymentStatus = status;
    Object.assign(this, details);
  }
}

function createBankClient({ bankUrl = 'http://localhost:4002', timeoutMs = 4000,
  attemptTimeoutMs = 1200, maxAttempts = 5, maxSockets = 10, keepAlive = true } = {}) {
  const url = new URL('charges', bankUrl.endsWith('/') ? bankUrl : `${bankUrl}/`);
  const transport = url.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive, maxSockets, maxFreeSockets: maxSockets, scheduling: 'lifo' });

  function requestCharge(payment, timeout) {
    return new Promise((resolve, reject) => {
      let connected = false;
      let complete = false;
      const body = JSON.stringify({ reference: payment.reference, amount: payment.amount });
      const req = transport.request(url, {
        method: 'POST', agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'Idempotency-Key': payment.reference },
      });
      // Starts before socket assignment, so time waiting in the pool counts too.
      const timer = setTimeout(() => {
        const error = new Error('Bank request timed out');
        error.code = 'BANK_TIMEOUT';
        req.destroy(error);
      }, Math.max(1, timeout));
      function fail(error) {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        // The lab contract maps every deadline expiry to PENDING, including pool wait.
        // A reset after connection also cannot establish whether a debit occurred.
        error.uncertain = connected || error.code === 'BANK_TIMEOUT';
        reject(error);
      }
      req.on('socket', socket => {
        if (!socket.connecting) connected = true;
        else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; });
      });
      req.on('error', fail);
      req.on('response', res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 65_536) req.destroy(new Error('Bank response is too large'));
          else chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('Bank response was interrupted')));
        res.on('end', () => {
          if (complete) return;
          complete = true;
          clearTimeout(timer);
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { data = null; }
          resolve({ code: res.statusCode, data });
        });
      });
      req.end(body);
    });
  }

  async function charge(payment) {
    const deadline = performance.now() + timeoutMs;
    let uncertain = payment.uncertain === true;
    let lastMessage = 'Bank is unavailable';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      payment.attempts += 1;
      let response;
      try {
        response = await requestCharge(payment, Math.min(attemptTimeoutMs, remaining));
      } catch (error) {
        uncertain ||= error.uncertain === true;
        payment.uncertain = uncertain;
        lastMessage = error.code === 'BANK_TIMEOUT' ? 'Timed out waiting for bank confirmation' : 'Cannot obtain bank confirmation';
        // ECONNREFUSED / failed DNS before connecting establish that this attempt did not debit.
      }
      if (response) {
        if (response.code === 201 && response.data?.status === 'SUCCEEDED'
            && response.data.reference === payment.reference && response.data.amount === payment.amount
            && typeof response.data.chargeId === 'string' && response.data.chargeId.length > 0) {
          return response.data;
        }
        if (response.code >= 400 && response.code < 500) {
          // An earlier ambiguous attempt must never be relabelled FAILED by a later rejection.
          if (uncertain) throw new BankError('An earlier bank attempt remains unconfirmed', 504, 'PENDING');
          throw new BankError(response.data?.error || 'Bank rejected payment', response.code, 'FAILED');
        }
        // The simulator explicitly guarantees its 500 occurs before debit.
        if (response.code !== 500) uncertain = true;
        payment.uncertain = uncertain;
        lastMessage = response.code === 500 ? 'Bank temporarily unavailable before debit' : 'Invalid bank confirmation';
      }
      if (attempt < maxAttempts) {
        const remainingAfterRequest = deadline - performance.now();
        const backoff = Math.min(50 * 2 ** (attempt - 1), 250, remainingAfterRequest);
        if (backoff > 0) await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
    throw new BankError(lastMessage, uncertain ? 504 : 503, uncertain ? 'PENDING' : 'FAILED');
  }

  return { charge, close: () => agent.destroy() };
}

module.exports = { createBankClient, BankError };
