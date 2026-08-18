const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

const root = __dirname;
const files = [
  'Config.gs', 'Utils.gs', 'Sheets.gs', 'Notion.gs', 'OpenAI.gs',
  'Apply.gs', 'Sync.gs', 'Telegram.gs', 'Core.gs', 'Tests.gs'
];

function createContext() {
  return {
    console,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    isNaN,
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest(_algorithm, value) {
        return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest())
          .map((x) => (x > 127 ? x - 256 : x));
      },
      formatDate(date, _tz, format) {
        const pad = (x) => String(x).padStart(2, '0');
        const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        if (format === 'yyyy-MM-dd') return ymd;
        return `${ymd}T${pad(date.getHours())}:${pad(date.getMinutes())}:00+09:00`;
      },
      sleep() {}
    }
  };
}

function runSuite(code, filename) {
  const context = createContext();
  vm.createContext(context);
  new vm.Script(code, { filename }).runInContext(context);
  const result = vm.runInContext('runUnitTests()', context);
  if (!result || !result.ok) process.exitCode = 1;
  return result;
}

const splitCode = files.map((name) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
runSuite(splitCode, 'volcano-automation-split.gs');

const bundlePath = path.join(root, 'VolcanoAutomation.bundle.gs');
if (fs.existsSync(bundlePath)) {
  runSuite(fs.readFileSync(bundlePath, 'utf8'), 'VolcanoAutomation.bundle.gs');
  console.log('분리형 소스와 배포 번들 검증 완료');
}
