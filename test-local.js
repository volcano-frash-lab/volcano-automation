const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');

const root = __dirname;
const files = [
  'Config.gs', 'Utils.gs', 'Sheets.gs', 'Notion.gs',
  'Apply.gs', 'Sync.gs', 'Telegram.gs', 'Core.gs', 'Tests.gs'
];
const installer = 'scripts/install_volcano_notion_sync.sh';
const policyFiles = [
  ...files,
  'VolcanoAutomation.bundle.gs',
  'appsscript.json',
  'package.json',
  'build-bundle.js',
  'test-local.js',
  'scripts/volcano_notion_sync.py',
  'scripts/tests/test_volcano_notion_sync.py',
  installer
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
    PropertiesService: undefined,
    LockService: undefined,
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

runPolicyChecks_();

function runPolicyChecks_() {
  const bundleCode = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, 'utf8') : '';
  const installerCode = fs.readFileSync(path.join(root, installer), 'utf8');
  const policyCode = policyFiles.map((name) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
  const providerName = ['open', 'ai'].join('');
  const apiKeyName = [providerName.toUpperCase(), 'API', 'KEY'].join('_');
  const apiHost = ['api', providerName, 'com'].join('\\.');
  const triggerBuilder = ['new', 'Trigger'].join('');

  assertPolicySource_(policyCode, [
    new RegExp(apiKeyName, 'i'),
    new RegExp(apiHost, 'i'),
    new RegExp('\\b' + providerName + '\\b', 'i')
  ], 'external model API dependency or path');

  assertPolicySource_(policyCode, [
    new RegExp('\\.\\s*' + triggerBuilder + '\\s*\\(', 'i')
  ], 'Apps Script trigger builder');

  assertPolicySource_(installerCode, [
    /\blaunchctl\b/i
  ], 'installer launchctl usage');

  validateBundleParity_(bundleCode);
  validateBundleCheckContract_();
}

function assertPolicySource_(subject, forbiddenPatterns, reason) {
  const hit = forbiddenPatterns.some((pattern) => pattern.test(subject));
  if (hit) throw new Error(reason + ' 금지 패턴이 감지되었습니다.');
}

function validateBundleParity_(bundle) {
  const markers = Array.from(bundle.matchAll(/^\/\/ ===== (.+?) =====$/gm))
    .map((match) => match[1].trim())
    .filter(Boolean);
  const bundleSet = {};
  markers.forEach((name) => {
    bundleSet[name] = (bundleSet[name] || 0) + 1;
  });
  if (files.length !== markers.length) {
    throw new Error('번들 섹션 개수가 분리형 소스 수와 일치하지 않습니다.');
  }
  files.forEach((name) => {
    if ((bundleSet[name] || 0) !== 1) {
      throw new Error('번들 섹션 누락 또는 중복: ' + name);
    }
  });
}

function validateBundleCheckContract_() {
  const packageScripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
  if (packageScripts.build !== 'node build-bundle.js') {
    throw new Error('npm run build는 명시적 번들 생성기로 유지되어야 합니다.');
  }
  if (packageScripts['check:bundle'] !== 'node build-bundle.js --check') {
    throw new Error('비변경 번들 검사 명령이 누락되었습니다.');
  }
  if (!String(packageScripts.validate || '').includes('npm run check:bundle') ||
      String(packageScripts.validate || '').includes('npm run build')) {
    throw new Error('validate는 생성 대신 비변경 번들 검사를 호출해야 합니다.');
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'volcano-bundle-check-'));
  try {
    fs.copyFileSync(path.join(root, 'build-bundle.js'), path.join(temporaryRoot, 'build-bundle.js'));
    files.forEach((name) => fs.copyFileSync(path.join(root, name), path.join(temporaryRoot, name)));
    const temporaryBundle = path.join(temporaryRoot, 'VolcanoAutomation.bundle.gs');
    const staleBundle = 'stale bundle sentinel\n';
    fs.writeFileSync(temporaryBundle, staleBundle, 'utf8');

    const staleCheck = childProcess.spawnSync(process.execPath, ['build-bundle.js', '--check'], {
      cwd: temporaryRoot,
      encoding: 'utf8'
    });
    if (staleCheck.status === 0) throw new Error('--check가 오래된 번들을 거부하지 않았습니다.');
    if (fs.readFileSync(temporaryBundle, 'utf8') !== staleBundle) {
      throw new Error('--check가 오래된 번들을 변경했습니다.');
    }

    const build = childProcess.spawnSync(process.execPath, ['build-bundle.js'], {
      cwd: temporaryRoot,
      encoding: 'utf8'
    });
    if (build.status !== 0) throw new Error('명시적 번들 생성 테스트가 실패했습니다.');
    const generatedBundle = fs.readFileSync(temporaryBundle, 'utf8');
    if (generatedBundle === staleBundle) throw new Error('명시적 번들 생성기가 번들을 갱신하지 않았습니다.');

    const currentCheck = childProcess.spawnSync(process.execPath, ['build-bundle.js', '--check'], {
      cwd: temporaryRoot,
      encoding: 'utf8'
    });
    if (currentCheck.status !== 0) throw new Error('--check가 최신 번들을 승인하지 않았습니다.');
    if (fs.readFileSync(temporaryBundle, 'utf8') !== generatedBundle) {
      throw new Error('--check가 최신 번들을 변경했습니다.');
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
