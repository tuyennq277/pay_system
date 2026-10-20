'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createLab, load, sleep } = require('./lab-helpers');

const modes = {
  before: { keepAlive: false, maxAttempts: 1, timeoutMs: 12_000, attemptTimeoutMs: 10_000 },
  after: {},
};
const round = value => Math.round(value * 10) / 10;

async function using(config, run) {
  const lab = await createLab(config);
  try { return await run(lab); }
  finally { await lab.close(); }
}

async function measure(mode) {
  const fee = modes[mode];
  console.log(`[${mode}] 1/4: unavailable bank and recovery`);
  const unavailable = await using({ fee, bankRunning: false }, async lab => {
    const payment = await lab.pay();
    const fees = await lab.fees();
    await lab.startBank();
    const recovery = await lab.pay();
    return { code: payment.code, status: payment.body.status, ms: round(payment.ms),
      feesCode: fees.code, feesMs: round(fees.ms), recoveryCode: recovery.code };
  });

  console.log(`[${mode}] 2/4: 5 s delay, 20 concurrent payments and a fee read`);
  const slow = await using({ fee, bank: { delayMs: 5000 } }, async lab => {
    const single = await lab.pay();
    const waiting = load(lab, 20, 20);
    await sleep(100);
    const fees = await lab.fees();
    const batch = await waiting;
    return { singleCode: single.code, singleStatus: single.body.status, singleMs: round(single.ms),
      concurrentPaid: batch.paid, concurrentPending: batch.pending,
      maxPaymentMs: round(Math.max(...batch.results.map(result => result.ms))),
      feesMs: round(fees.ms), outstanding: (await lab.fees()).body.outstanding };
  });

  console.log(`[${mode}] 3/4: 200 payments, concurrency 10, then idle 6 s`);
  const pooling = await using({ fee }, async lab => {
    const batch = await load(lab, 200, 10);
    const stats = (await lab.stats()).body;
    await sleep(6000);
    const next = await load(lab, 5, 5);
    return { paid: batch.paid, totalMs: round(batch.ms), ...stats, afterIdlePaid: next.paid };
  });

  console.log(`[${mode}] 4/4: DROP_RATE / FAIL_RATE 0.3 and explicit rejection`);
  const faults = {};
  for (const [name, bank] of Object.entries({ drop: { dropRate: 0.3 }, fail: { failRate: 0.3 } })) {
    faults[name] = await using({ fee, bank }, async lab => {
      const batch = await load(lab, 60);
      return { paid: batch.paid, pending: batch.pending, failed: batch.failed, totalMs: round(batch.ms),
        maxPaymentMs: round(Math.max(...batch.results.map(result => result.ms))),
        ...(await lab.stats()).body, outstanding: (await lab.fees()).body.outstanding };
    });
  }
  faults.rejected = await using({ fee }, async lab => {
    const result = await lab.pay(25_000_000);
    return { code: result.code, status: result.body.status, ...(await lab.stats()).body };
  });
  return { unavailable, slow, pooling, faults };
}

function markdown(report) {
  const b = report.before;
  const a = report.after;
  const rows = [
    ['1 — Ngân hàng tắt: HTTP / thời gian', `${b.unavailable.code} / ${b.unavailable.ms} ms`, `${a.unavailable.code} / ${a.unavailable.ms} ms`],
    ['1 — GET công nợ lúc ngân hàng tắt', `${b.unavailable.feesCode} / ${b.unavailable.feesMs} ms`, `${a.unavailable.feesCode} / ${a.unavailable.feesMs} ms`],
    ['1 — Ngân hàng bật lại, giữ nguyên Fee Service', b.unavailable.recoveryCode, a.unavailable.recoveryCode],
    ['2 — Một thanh toán, DELAY_MS=5000', `${b.slow.singleCode} ${b.slow.singleStatus} / ${b.slow.singleMs} ms`, `${a.slow.singleCode} ${a.slow.singleStatus} / ${a.slow.singleMs} ms`],
    ['2 — 20 đồng thời: PAID / PENDING', `${b.slow.concurrentPaid} / ${b.slow.concurrentPending}`, `${a.slow.concurrentPaid} / ${a.slow.concurrentPending}`],
    ['2 — Thời gian thanh toán lớn nhất', `${b.slow.maxPaymentMs} ms`, `${a.slow.maxPaymentMs} ms`],
    ['2 — GET công nợ trong lúc chờ', `${b.slow.feesMs} ms`, `${a.slow.feesMs} ms`],
    ['3 — Thành công / tổng thời gian (200, đồng thời 10)', `${b.pooling.paid}/200 / ${b.pooling.totalMs} ms`, `${a.pooling.paid}/200 / ${a.pooling.totalMs} ms`],
    ['3 — Kết nối TCP ngân hàng', b.pooling.connections, a.pooling.connections],
    ['3 — Thành công sau nhàn rỗi 6 s', `${b.pooling.afterIdlePaid}/5`, `${a.pooling.afterIdlePaid}/5`],
    ['4a — DROP_RATE=0.3: PAID / PENDING / charges / duplicates', `${b.faults.drop.paid} / ${b.faults.drop.pending} / ${b.faults.drop.charges} / ${b.faults.drop.duplicates}`, `${a.faults.drop.paid} / ${a.faults.drop.pending} / ${a.faults.drop.charges} / ${a.faults.drop.duplicates}`],
    ['4a — Công nợ còn lại', b.faults.drop.outstanding, a.faults.drop.outstanding],
    ['4b — FAIL_RATE=0.3: PAID / FAILED / charges / duplicates', `${b.faults.fail.paid} / ${b.faults.fail.failed} / ${b.faults.fail.charges} / ${b.faults.fail.duplicates}`, `${a.faults.fail.paid} / ${a.faults.fail.failed} / ${a.faults.fail.charges} / ${a.faults.fail.duplicates}`],
    ['4c — 25.000.000đ: HTTP / số request ngân hàng', `${b.faults.rejected.code} / ${b.faults.rejected.requests}`, `${a.faults.rejected.code} / ${a.faults.rejected.requests}`],
  ];
  return `# Số liệu thực nghiệm trước / sau\n\nChạy lúc ${report.generatedAt}, Node ${report.node}, ${report.platform}.\n\n`
    + 'Baseline dùng cùng mã nghiệp vụ, tắt keep-alive, chỉ 1 lần gọi, timeout 10 s/lần (ngân sách 12 s). Bản sau dùng cấu hình mặc định: keep-alive, tối đa 10 socket, 5 lần gọi, ngân sách chung 4 s. Đây là so sánh cấu hình tái lập, không phải số liệu từ một phiên bản cũ chưa có trong thư mục.\n\n'
    + '| Phép đo | Trước | Sau |\n|---|---:|---:|\n'
    + rows.map(row => `| ${row.join(' | ')} |`).join('\n')
    + '\n\nMỗi phép đo dùng dữ liệu bộ nhớ mới; tiền thanh toán là 1.000đ, trừ ca từ chối. Số TCP tính cả kết nối đọc `/stats` (thường thêm 1). Seed cố định 20261020 để tái lập lỗi; service chạy thật dùng Math.random. Thời gian phụ thuộc máy. `requests` chỉ đếm POST /charges; replay vẫn tính request nhưng không thêm charge.\n\n'
    + 'PENDING giữ nguyên công nợ và giữ chỗ số tiền chờ xác nhận. Ngân hàng có thể hoàn tất sau khi client timeout; công nợ chỉ giảm khi retry cùng payment nhận được xác nhận.\n';
}

(async () => {
  const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform };
  for (const mode of Object.keys(modes)) report[mode] = await measure(mode);
  const directory = path.join(__dirname, '..', 'results');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(directory, 'benchmark.md'), markdown(report));
  console.log('Saved results/benchmark.json and results/benchmark.md');
})().catch(error => { console.error(error); process.exitCode = 1; });
