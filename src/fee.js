'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { createBankClient, BankError } = require('./bank-client');
const { feeConfig } = require('./config');

function createFeeServer(config = {}) {
  const app = express();
  const bank = createBankClient(config);
  // Scope bank references to this process, since P1 restarts from 1 after a restart.
  const instanceId = randomUUID();
  const students = new Map([[1, { outstanding: 50_000_000, reserved: 0 }],
    [2, { outstanding: 0, reserved: 0 }], [3, { outstanding: 3_200_000, reserved: 0 }]]);
  const payments = new Map();
  const inFlight = new Map();
  let sequence = 0;
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/', (req, res) => res.type('html').send(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fee Service</title></head>
<body><h1>Fee Service — Thanh toán học phí</h1>
<p>Service đang chạy. Chọn sinh viên để xem công nợ:</p>
<ul><li><a href="/students/1/fees">Sinh viên 1</a></li>
<li><a href="/students/2/fees">Sinh viên 2</a></li>
<li><a href="/students/3/fees">Sinh viên 3</a></li></ul>
<p>Để thanh toán, dùng Postman gửi <code>POST /students/1/payments</code>,
header <code>Content-Type: application/json</code> và body:</p>
<pre>{"amount":100000}</pre>
<p>Gõ địa chỉ trong trình duyệt chỉ gửi GET; endpoint thanh toán yêu cầu POST.</p>
<p>Xem lệnh tại <code>GET /payments/P1</code>. Xác nhận lại lệnh PENDING bằng
<code>POST /payments/P1/retry</code>.</p></body></html>`));

  function studentFor(req) {
    return /^\d+$/.test(req.params.id) ? students.get(Number(req.params.id)) : undefined;
  }
  function fail(res, code, error, paymentId = null, status = 'FAILED') {
    return res.status(code).json({ error, paymentId, status });
  }
  function view(payment) {
    return { paymentId: payment.paymentId, studentId: payment.studentId, amount: payment.amount,
      status: payment.status, chargeId: payment.chargeId, attempts: payment.attempts,
      outstanding: students.get(payment.studentId).outstanding };
  }

  app.get('/students/:id/fees', (req, res) => {
    const student = studentFor(req);
    if (!student) return fail(res, 404, 'Student not found');
    return res.json({ studentId: Number(req.params.id), outstanding: student.outstanding,
      reserved: student.reserved, available: student.outstanding - student.reserved, currency: 'VND' });
  });

  async function processPayment(payment) {
    if (inFlight.has(payment.paymentId)) return inFlight.get(payment.paymentId);
    const task = (async () => {
      const student = students.get(payment.studentId);
      try {
        const charge = await bank.charge(payment);
        student.outstanding -= payment.amount;
        student.reserved -= payment.amount;
        payment.status = 'PAID';
        payment.chargeId = charge.chargeId;
        payment.lastError = undefined;
        payment.httpStatus = 201;
      } catch (error) {
        const known = error instanceof BankError;
        // Unexpected errors are conservatively uncertain; never release a possibly debited payment.
        payment.status = known ? error.paymentStatus : 'PENDING';
        payment.httpStatus = known ? error.httpStatus : 504;
        payment.lastError = known ? error.message : 'Payment confirmation is unavailable';
        if (payment.status === 'FAILED') student.reserved -= payment.amount;
      }
      return payment;
    })();
    inFlight.set(payment.paymentId, task);
    try { return await task; }
    finally { inFlight.delete(payment.paymentId); }
  }

  function respond(res, payment) {
    if (payment.status === 'PAID') return res.status(201).json(view(payment));
    return fail(res, payment.httpStatus, payment.lastError, payment.paymentId, payment.status);
  }

  app.post('/students/:id/payments', async (req, res) => {
    const student = studentFor(req);
    if (!student) return fail(res, 404, 'Student not found');
    const amount = req.body?.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail(res, 400, 'Amount must be a positive integer in VND');
    if (amount > student.outstanding - student.reserved) return fail(res, 400, 'Amount exceeds available outstanding fees');
    const paymentId = `P${++sequence}`;
    const payment = { paymentId, studentId: Number(req.params.id), amount, status: 'PENDING',
      reference: `${instanceId}:${paymentId}`, attempts: 0 };
    // Reserve synchronously before the first await to prevent concurrent overpayment.
    student.reserved += amount;
    payments.set(paymentId, payment);
    await processPayment(payment);
    return respond(res, payment);
  });

  app.get('/payments/:paymentId', (req, res) => {
    const payment = payments.get(req.params.paymentId);
    if (!payment) return fail(res, 404, 'Payment not found');
    return res.json({ ...view(payment), error: payment.lastError });
  });

  app.post('/payments/:paymentId/retry', async (req, res) => {
    const payment = payments.get(req.params.paymentId);
    if (!payment) return fail(res, 404, 'Payment not found');
    if (payment.status === 'PENDING') await processPayment(payment);
    return respond(res, payment);
  });

  app.use((req, res) => fail(res, 404, 'Route not found'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return fail(res, error.status === 413 ? 413 : 400, 'Invalid JSON request body');
  });
  const server = http.createServer(app);
  server.on('close', () => bank.close());
  return server;
}

if (require.main === module) {
  const { port, ...config } = feeConfig();
  const server = createFeeServer(config);
  server.listen(port, () => console.log(`[fee] Listening on http://localhost:${port}; bank=${config.bankUrl}`));
  server.on('error', error => { console.error(`[fee] ${error.message}`); process.exitCode = 1; });
}

module.exports = { createFeeServer };
