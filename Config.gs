const CONFIG = Object.freeze({
  TIMEZONE: 'Asia/Seoul',
  SHEET_ID: '1KHr1i8dU_0ojIHTWEEWrx3t_DuqpiZWu5S8dJQDxHic',
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/1KHr1i8dU_0ojIHTWEEWrx3t_DuqpiZWu5S8dJQDxHic/edit',
  PROJECT_TAB: '_프로젝트통합',
  SCHEDULE_TAB: '_일정통합',
  NOTION_VERSION: '2026-03-11',
  NOTION_API: 'https://api.notion.com/v1',
  OPENAI_API: 'https://api.openai.com/v1/responses',
  DATABASES: Object.freeze({
    PLAUD: '7c9a94e7-87a0-4bb2-89fb-52f9b0ddf442',
    PROJECTS: '23db7878-81fc-4429-a4e3-97298babf1c8',
    SCHEDULES: '7cb2c573-b26a-452e-a509-9cc49582b3c0',
    OPS: '59f797a6-4277-4a5c-8a24-b4a3e1c574f8'
  }),
  DASHBOARD_PAGE_ID: '3bfd8ec2-afe2-8100-9444-c49eb961618f',
  INITIAL_CHECKPOINT: '2026-08-17T10:40:44.000Z',
  POLL_PAGE_SIZE: 25,
  MAX_MEETINGS_PER_RUN: 3,
  MAX_BLOCK_DEPTH: 4,
  MAX_BLOCKS_PER_RECORD: 500,
  MAX_TRANSCRIPT_CHARS: 60000,
  RUN_BUDGET_MS: 270000,
  MAX_WEBHOOK_TEXT_CHARS: 2200,
  MAX_WEBHOOK_QUEUE_ITEMS: 30,
  WEBHOOK_QUEUE_PREFIX: 'TG_QUEUE_',
  TRAVEL_BUFFER_MINUTES: 90,
  OPENAI_MODEL_DEFAULT: 'gpt-5.4-nano'
});

const REQUIRED_SCRIPT_PROPERTIES = Object.freeze([
  'NOTION_TOKEN',
  'OPENAI_API_KEY'
]);

function getSettings_() {
  const p = PropertiesService.getScriptProperties();
  return {
    notionToken: p.getProperty('NOTION_TOKEN') || '',
    openaiKey: p.getProperty('OPENAI_API_KEY') || '',
    openaiModel: p.getProperty('OPENAI_MODEL') || CONFIG.OPENAI_MODEL_DEFAULT,
    telegramBotToken: p.getProperty('TELEGRAM_BOT_TOKEN') || '',
    telegramAllowedChatId: p.getProperty('TELEGRAM_ALLOWED_CHAT_ID') || '',
    webhookKey: p.getProperty('WEBHOOK_KEY') || '',
    reportChatId: p.getProperty('TELEGRAM_REPORT_CHAT_ID') || p.getProperty('TELEGRAM_ALLOWED_CHAT_ID') || ''
  };
}

function validateSettings_() {
  const settings = getSettings_();
  const missing = [];
  if (!settings.notionToken) missing.push('NOTION_TOKEN');
  if (!settings.openaiKey) missing.push('OPENAI_API_KEY');
  if (missing.length) throw new Error('Script Properties에 다음 값을 설정하세요: ' + missing.join(', '));
  return settings;
}
