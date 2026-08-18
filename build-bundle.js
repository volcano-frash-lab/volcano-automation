const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const sourceFiles = [
  'Config.gs',
  'Utils.gs',
  'Sheets.gs',
  'Notion.gs',
  'OpenAI.gs',
  'Apply.gs',
  'Sync.gs',
  'Telegram.gs',
  'Core.gs',
  'Tests.gs'
];
const outputFile = path.join(root, 'VolcanoAutomation.bundle.gs');

const banner = [
  '/**',
  ' * 볼케이노 PLAUD → Notion 자동화 배포 번들',
  ' * 자동 생성 파일입니다. 분리형 .gs 파일을 수정한 뒤 npm run build를 실행하세요.',
  ' * Apps Script에는 이 번들만 Code.gs로 붙여넣고 분리형 파일과 함께 배포하지 마세요.',
  ' */'
].join('\n');

const sections = sourceFiles.map((name) => {
  const content = fs.readFileSync(path.join(root, name), 'utf8').trimEnd();
  return `\n\n// ===== ${name} =====\n${content}`;
});

fs.writeFileSync(outputFile, `${banner}${sections.join('')}\n`, 'utf8');
console.log(`번들 생성 완료: ${path.basename(outputFile)} (${sourceFiles.length}개 소스)`);
