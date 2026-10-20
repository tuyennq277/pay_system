'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const children = ['bank', 'fee'].map(name => spawn(process.execPath, [path.join(__dirname, '..', 'src', `${name}.js`)], {
  stdio: 'inherit', windowsHide: true,
}));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
