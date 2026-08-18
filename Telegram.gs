const TELEGRAM_QUEUE_RUN_LIMIT_MS_ = 4.5 * 60 * 1000;
const TELEGRAM_QUEUE_START_RESERVE_MS_ = 90 * 1000;
const TELEGRAM_QUEUE_LOCK_WAIT_MS_ = 2000;

function doPost(e) {
  console.log('Telegram 웹훅 수신은 수동 폴백 모드에서 비활성화되어 있습니다.');
  return outputJson_({ ok: false, queued: false, error: 'webhook_disabled_for_manual_fallback' }, 200);
}

function enqueueTelegramRecord_(record, digest) {
  return withTelegramQueueLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const all = props.getProperties();
    const keys = Object.keys(all).filter(function (key) { return key.indexOf(CONFIG.WEBHOOK_QUEUE_PREFIX) === 0; });
    const key = telegramQueueKey_(record.id);
    const current = safely_(function () { return all[key] ? JSON.parse(all[key]) : null; }, null);
    if (current && String(current.digest) === String(digest)) {
      return { queued: false, duplicate: true, replaced: false };
    }
    if (!all[key] && keys.length >= CONFIG.MAX_WEBHOOK_QUEUE_ITEMS) throw new Error('웹훅 대기열이 가득 찼습니다.');
    const item = { record: record, digest: digest, enqueuedAt: isoNow_(), attempts: 0, retryAfter: 0, lastError: '' };
    props.setProperty(key, serializeTelegramQueueItem_(item));
    return { queued: true, duplicate: false, replaced: Boolean(all[key]) };
  });
}

function processTelegramQueue() {
  console.log('processTelegramQueue는 Mac mini 구독 런타임이 권한합니다. Apps Script는 수동 폴백 모드입니다.');
}

function withTelegramQueueLock_(fn) {
  // 웹훅은 짧은 UserLock만 사용하므로 장시간 ScriptLock 작업과 충돌하지 않는다.
  // setWebhook의 max_connections=1과 함께 웹훅 간 동시 등록도 직렬화한다.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(TELEGRAM_QUEUE_LOCK_WAIT_MS_)) throw new Error('웹훅 대기열 잠금 실패');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function telegramQueueKey_(recordId) {
  return CONFIG.WEBHOOK_QUEUE_PREFIX + hashText_(recordId).slice(0, 24);
}

function serializeTelegramQueueItem_(item) {
  const serialized = JSON.stringify(item);
  if (serialized.length > 8500) throw new Error('Telegram 요약이 대기열 저장 한도를 초과했습니다.');
  return serialized;
}

function nextTelegramQueueItem_() {
  return withTelegramQueueLock_(function () {
    const all = PropertiesService.getScriptProperties().getProperties();
    const keys = Object.keys(all).filter(function (key) {
      return key.indexOf(CONFIG.WEBHOOK_QUEUE_PREFIX) === 0;
    }).sort(function (a, b) {
      const av = safely_(function () { return JSON.parse(all[a]).enqueuedAt; }, '');
      const bv = safely_(function () { return JSON.parse(all[b]).enqueuedAt; }, '');
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    const key = keys.find(function (candidateKey) {
      const candidate = safely_(function () { return JSON.parse(all[candidateKey]); }, null);
      return candidate && Number(candidate.retryAfter || 0) <= Date.now();
    });
    if (!key) return null;
    return { key: key, item: JSON.parse(all[key]) };
  });
}

function isTelegramQueueItemCurrent_(key, digest) {
  return withTelegramQueueLock_(function () {
    const raw = PropertiesService.getScriptProperties().getProperty(key);
    const current = safely_(function () { return raw ? JSON.parse(raw) : null; }, null);
    return Boolean(current && String(current.digest) === String(digest));
  });
}

function deleteTelegramQueueItemIfCurrent_(key, digest) {
  return withTelegramQueueLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(key);
    const current = safely_(function () { return raw ? JSON.parse(raw) : null; }, null);
    if (!current || String(current.digest) !== String(digest)) return false;
    props.deleteProperty(key);
    return true;
  });
}

function recordTelegramQueueFailure_(key, item, error) {
  return withTelegramQueueLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(key);
    const current = safely_(function () { return raw ? JSON.parse(raw) : null; }, null);
    if (!current || String(current.digest) !== String(item.digest)) {
      return { updated: false, replaced: Boolean(current), dead: false };
    }
    current.attempts = Number(current.attempts || 0) + 1;
    current.lastError = String(error.message || error).slice(0, 500);
    current.lastAttemptAt = isoNow_();
    current.retryAfter = Date.now() + Math.min(60, Math.pow(2, current.attempts)) * 60000;
    if (current.attempts >= 5) {
      props.setProperty('TG_DEAD_' + key.slice(CONFIG.WEBHOOK_QUEUE_PREFIX.length),
        serializeTelegramQueueItem_(current));
      props.deleteProperty(key);
      return { updated: true, replaced: false, dead: true, item: current };
    }
    props.setProperty(key, serializeTelegramQueueItem_(current));
    return { updated: true, replaced: false, dead: false, item: current };
  });
}

function hasTelegramQueueRunTime_(deadlineMs, reserveMs) {
  return Date.now() + Number(reserveMs || 0) < Number(deadlineMs || 0);
}

function doGet() {
  return outputJson_({ ok: true, service: 'volcano-plaud-sync', time: isoNow_() }, 200);
}

function telegramMessageUrl_(message) {
  const username = message.chat && message.chat.username;
  if (username && message.message_id) return 'https://t.me/' + username + '/' + message.message_id;
  return '';
}

function sendTelegramReport_(text) {
  const settings = getSettings_();
  if (!settings.telegramBotToken || !settings.reportChatId || !text) return;
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + settings.telegramBotToken + '/sendMessage', {
    method: 'post', muteHttpExceptions: true,
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: settings.reportChatId, text: text, disable_web_page_preview: true })
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) console.error('Telegram 보고 실패: ' + response.getContentText());
}

function formatReport_(report, title) {
  const lines = ['PLAUD 반영 완료: ' + title];
  if (report.projects.length) lines.push('프로젝트: ' + report.projects.join(', '));
  if (report.ops.length) lines.push('운영과제: ' + report.ops.join(', '));
  if (report.schedules.length) lines.push('일정: ' + report.schedules.join(', '));
  if (report.conflicts.length) lines.push('일정 충돌: ' + report.conflicts.join(', '));
  if (report.confirmations.length) lines.push('사람 확인: ' + report.confirmations.join(' / '));
  return lines.join('\n').slice(0, 3900);
}

function setTelegramWebhook() {
  throw new Error('Telegram webhook 설치는 수동 폴백 모드에서 비활성화되어 있습니다.');
}
