const TELEGRAM_QUEUE_RUN_LIMIT_MS_ = 4.5 * 60 * 1000;
const TELEGRAM_QUEUE_START_RESERVE_MS_ = 90 * 1000;
const TELEGRAM_QUEUE_LOCK_WAIT_MS_ = 2000;

function doPost(e) {
  try {
    const settings = getSettings_();
    if (!settings.webhookKey || !settings.telegramAllowedChatId) {
      return outputJson_({ ok: false, queued: false, error: 'webhook_not_configured' }, 503);
    }
    if (!e || !e.parameter || e.parameter.key !== settings.webhookKey) {
      return outputJson_({ ok: false, queued: false, error: 'unauthorized' }, 403);
    }
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    const message = payload.message || payload.channel_post || payload.edited_message || payload.edited_channel_post || {};
    const chatId = message.chat && String(message.chat.id || '');
    if (!chatId || chatId !== String(settings.telegramAllowedChatId)) {
      return outputJson_({ ok: true, ignored: 'chat_not_allowed' }, 200);
    }
    const text = String(message.text || message.caption || '').trim();
    if (!text) return outputJson_({ ok: true, ignored: 'empty' }, 200);
    if (text.length < 40) return outputJson_({ ok: true, ignored: 'too_short' }, 200);
    const sourceKey = 'telegram:' + chatId + ':' + String(message.message_id || hashText_(text).slice(0, 12));
    const digest = hashText_(text);
    if (isProcessed_(sourceKey, digest)) return outputJson_({ ok: true, duplicate: true }, 200);
    const record = {
      id: sourceKey,
      recordingId: sourceKey,
      title: 'Telegram PLAUD 요약',
      url: telegramMessageUrl_(message),
      recordedAt: message.date ? new Date(Number(message.date) * 1000).toISOString() : isoNow_(),
      lastEditedAt: isoNow_(),
      text: text.slice(0, CONFIG.MAX_WEBHOOK_TEXT_CHARS)
    };
    const queueResult = enqueueTelegramRecord_(record, digest);
    return outputJson_(Object.assign({ ok: true }, queueResult), 200);
  } catch (error) {
    const detail = String(error.message || error);
    console.error('Telegram 웹훅 대기열 등록 실패: ' + (error && error.stack ? error.stack : detail));
    // Apps Script ContentService 웹 앱은 실제 HTTP status code를 설정할 API가 없다.
    // 따라서 outputJson_의 status는 응답 body의 애플리케이션 상태이며 실제 HTTP 응답은 200일 수 있다.
    return outputJson_({
      ok: false,
      queued: false,
      retryable: true,
      error: 'queue_registration_failed',
      detail: detail.slice(0, 500),
      actualHttpStatusMayBe200: true
    }, 503);
  }
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
  const deadlineMs = Date.now() + TELEGRAM_QUEUE_RUN_LIMIT_MS_;
  const workerLock = LockService.getScriptLock();
  if (!workerLock.tryLock(1000)) return;
  setNotionRunDeadline_(deadlineMs);
  try {
    validateSettings_();
    const claimed = nextTelegramQueueItem_();
    if (!claimed) return;
    const key = claimed.key;
    const item = claimed.item;
    if (isProcessed_(item.record.id, item.digest)) {
      deleteTelegramQueueItemIfCurrent_(key, item.digest);
      return;
    }
    if (!hasTelegramQueueRunTime_(deadlineMs, TELEGRAM_QUEUE_START_RESERVE_MS_)) {
      console.warn('Telegram 대기열 작업 시작에 필요한 90초가 남지 않아 다음 실행으로 넘깁니다.');
      return;
    }
    try {
      const sourceData = readSourceData_();
      const analysis = analyzeMeeting_(item.record, sourceData);
      if (!isTelegramQueueItemCurrent_(key, item.digest)) {
        console.warn('Telegram 메시지가 처리 중 수정되어 이전 digest 반영을 건너뜁니다: ' + item.record.id);
        return;
      }
      const report = applyAnalysis_(item.record, analysis, sourceData);
      rememberProcessed_(item.record.id, item.digest);
      deleteTelegramQueueItemIfCurrent_(key, item.digest);
      sendTelegramReport_(formatReport_(report, item.record.title));
    } catch (error) {
      if (error && error.code === 'PLAUD_DEADLINE') {
        console.warn(error.message);
        return;
      }
      const failure = recordTelegramQueueFailure_(key, item, error);
      if (failure && failure.dead) {
        sendTelegramReport_('PLAUD Telegram 처리 5회 실패. Apps Script 실행 로그 확인 필요: ' + failure.item.lastError);
      }
      console.error(error && error.stack ? error.stack : error);
    }
  } finally {
    clearNotionRunDeadline_();
    workerLock.releaseLock();
  }
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
  const settings = getSettings_();
  if (!settings.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN을 먼저 설정하세요.');
  if (!settings.webhookKey) throw new Error('WEBHOOK_KEY를 먼저 설정하세요.');
  if (!settings.telegramAllowedChatId) throw new Error('TELEGRAM_ALLOWED_CHAT_ID를 먼저 설정하세요.');
  const webAppUrl = ScriptApp.getService().getUrl();
  if (!webAppUrl) throw new Error('먼저 웹 앱으로 배포하세요.');
  const webhookUrl = webAppUrl + '?key=' + encodeURIComponent(settings.webhookKey);
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + settings.telegramBotToken + '/setWebhook', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ url: webhookUrl, max_connections: 1, allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post'] })
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Telegram setWebhook 실패: ' + response.getContentText());
  console.log(response.getContentText());
  return response.getContentText();
}
