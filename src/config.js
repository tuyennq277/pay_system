'use strict';

function numberEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = true } = {}) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}

function bankConfig() {
  return {
    port: numberEnv('BANK_PORT', 4002, { max: 65535 }),
    delayMs: numberEnv('DELAY_MS', 0),
    failRate: numberEnv('FAIL_RATE', 0, { max: 1, integer: false }),
    dropRate: numberEnv('DROP_RATE', 0, { max: 1, integer: false }),
  };
}

function feeConfig() {
  const bankUrl = new URL(process.env.BANK_URL || 'http://localhost:4002');
  if (!['http:', 'https:'].includes(bankUrl.protocol) || bankUrl.username || bankUrl.password) {
    throw new Error('BANK_URL must be an HTTP(S) URL without embedded credentials');
  }
  const keepAlive = process.env.BANK_KEEP_ALIVE ?? 'true';
  if (!['true', 'false'].includes(keepAlive)) throw new Error('BANK_KEEP_ALIVE must be true or false');
  return {
    port: numberEnv('FEE_PORT', 4001, { max: 65535 }),
    bankUrl: bankUrl.href,
    timeoutMs: numberEnv('BANK_TIMEOUT_MS', 4000, { min: 1 }),
    attemptTimeoutMs: numberEnv('BANK_ATTEMPT_TIMEOUT_MS', 1200, { min: 1 }),
    maxAttempts: numberEnv('BANK_MAX_ATTEMPTS', 5, { min: 1, max: 10 }),
    maxSockets: numberEnv('BANK_MAX_SOCKETS', 10, { min: 1 }),
    keepAlive: keepAlive === 'true',
  };
}

module.exports = { bankConfig, feeConfig };
