const Module = require('module');
const cases = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
let lastHeaders = null;
const stubs = {
  axios: { post: async (_u, _f, o) => { lastHeaders = o.headers; return { status: 200, data: {} }; } },
  '@librechat/data-schemas': { logger: { warn() {}, error() {}, debug() {}, info() {} } },
  './config': { getConfig: () => ({ bffBaseUrl: 'http://x', timeoutMs: 1000 }) },
};
const orig = Module._load;
Module._load = function (request, ...rest) { return request in stubs ? stubs[request] : orig.call(this, request, ...rest); };
const { callConsoleFilesProxy } = require(process.argv[3]);
(async () => {
  const out = [];
  for (const c of cases) {
    lastHeaders = null;
    await callConsoleFilesProxy({ token: 't', filePath: '/etc/hostname', filename: 'x', sessionId: c });
    const k = Object.keys(lastHeaders).find((h) => h.toLowerCase() === 'x-session-id');
    out.push(k ? lastHeaders[k] : null);
  }
  console.log(JSON.stringify(out));
})();
