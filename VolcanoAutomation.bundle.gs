/**
 * 볼케이노 PLAUD → Notion 자동화 배포 번들
 * 자동 생성 파일입니다. 분리형 .gs 파일을 수정한 뒤 npm run build를 실행하세요.
 * Apps Script에는 이 번들만 Code.gs로 붙여넣고 분리형 파일과 함께 배포하지 마세요.
 */

// ===== Config.gs =====
const CONFIG = Object.freeze({
  TIMEZONE: 'Asia/Seoul',
  SHEET_ID: '1KHr1i8dU_0ojIHTWEEWrx3t_DuqpiZWu5S8dJQDxHic',
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/1KHr1i8dU_0ojIHTWEEWrx3t_DuqpiZWu5S8dJQDxHic/edit',
  PROJECT_TAB: '_프로젝트통합',
  SCHEDULE_TAB: '_일정통합',
  NOTION_VERSION: '2026-03-11',
  NOTION_API: 'https://api.notion.com/v1',
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
  TRAVEL_BUFFER_MINUTES: 90
});

const REQUIRED_SCRIPT_PROPERTIES = Object.freeze([
  'NOTION_TOKEN'
]);

function getSettings_() {
  const p = PropertiesService.getScriptProperties();
  return {
    notionToken: p.getProperty('NOTION_TOKEN') || '',
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
  if (missing.length) throw new Error('Script Properties에 다음 값을 설정하세요: ' + missing.join(', '));
  return settings;
}

// ===== Utils.gs =====
function rowsToObjects_(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map(function (v) { return String(v || '').trim(); });
  return values.slice(1).filter(function (row) {
    return row.some(function (v) { return v !== '' && v !== null && v !== undefined; });
  }).map(function (row) {
    const result = {};
    headers.forEach(function (header, index) {
      if (header) result[header] = row[index] === undefined ? '' : row[index];
    });
    return result;
  });
}

function normalizeName_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^0-9a-z가-힣]/g, '');
}

function normalizeUrl_(value) {
  return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
}

function validHttpUrl_(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function parseLocalDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') return value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const absolute = new Date(text);
    return isNaN(absolute.getTime()) ? null : absolute;
  }
  const m = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), 0, 0);
}

function isoLocal_(value) {
  const date = parseLocalDate_(value);
  if (!date || isNaN(date.getTime())) return '';
  const hasTime = /\d{1,2}:\d{2}/.test(String(value));
  return Utilities.formatDate(date, CONFIG.TIMEZONE, hasTime ? "yyyy-MM-dd'T'HH:mm:ssXXX" : 'yyyy-MM-dd');
}

function isoNow_() {
  return new Date().toISOString();
}

function hashText_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value || ''), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function richText_(value) {
  if (value === null || value === undefined || value === '') return [];
  return chunkText_(String(value), 1900).map(function (part) {
    return { type: 'text', text: { content: part } };
  });
}

function chunkText_(value, maxLength) {
  const text = String(value || '');
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) chunks.push(text.slice(i, i + maxLength));
  return chunks.length ? chunks : [''];
}

function titleProperty_(value) { return { title: richText_(value) }; }
function textProperty_(value) { return { rich_text: richText_(value) }; }
function selectProperty_(value) { return value ? { select: { name: String(value) } } : { select: null }; }
function checkboxProperty_(value) { return { checkbox: Boolean(value) }; }
function urlProperty_(value) { return { url: validHttpUrl_(value) ? String(value) : null }; }
function dateProperty_(value) { return value ? { date: { start: String(value) } } : { date: null }; }

function plainProperty_(property) {
  if (!property) return '';
  const type = property.type;
  if (type === 'title') return (property.title || []).map(function (x) { return x.plain_text || ''; }).join('');
  if (type === 'rich_text') return (property.rich_text || []).map(function (x) { return x.plain_text || ''; }).join('');
  if (type === 'url') return property.url || '';
  if (type === 'select') return property.select ? property.select.name : '';
  if (type === 'date') return property.date ? property.date.start : '';
  if (type === 'checkbox') return Boolean(property.checkbox);
  if (type === 'number') return property.number;
  if (type === 'created_time') return property.created_time || '';
  if (type === 'last_edited_time') return property.last_edited_time || '';
  return '';
}

function mapSheetStage_(rawStatus) {
  const s = String(rawStatus || '');
  if (/거절|종료/.test(s)) return '종료';
  if (/보류/.test(s)) return '보류';
  if (/결과확인필요|답변대기/.test(s)) return '확인 필요';
  if (/예정|확정/.test(s)) return '예정';
  if (/완료/.test(s) && /후속확인|후속미팅|재접촉/.test(s)) return '진행';
  if (/완료/.test(s)) return '완료';
  return '진행';
}

function overlapWithBuffer_(aStart, aEnd, bStart, bEnd, bufferMinutes) {
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd || aStart).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd || bStart).getTime();
  if ([as, ae, bs, be].some(isNaN)) return false;
  const buffer = Number(bufferMinutes || 0) * 60000;
  return as < be + buffer && bs < ae + buffer;
}

function scheduleSourceFingerprint_(schedule) {
  const evidence = String(schedule.evidence_quote || '').replace(/\s+/g, ' ').trim();
  if (evidence.length >= 8) return 'evidence-' + hashText_(evidence).slice(0, 16);
  const semanticKey = normalizeName_(schedule.title || schedule.type || schedule.channel_name || '일정');
  return 'semantic-' + hashText_(semanticKey).slice(0, 16);
}

function stableScheduleEventKey_(schedule, occurrence) {
  return 'event-' + hashText_([
    schedule.project_id,
    scheduleSourceFingerprint_(schedule),
    Number(occurrence || 1)
  ].join('|')).slice(0, 12);
}

function stableScheduleId_(sourceKey, schedule, eventKey) {
  const stableEvent = eventKey || stableScheduleEventKey_(schedule, 1);
  return 'PLAUD-' + hashText_([sourceKey, schedule.project_id, stableEvent].join('|')).slice(0, 16);
}

function evidencePresent_(sourceText, quote) {
  const normalize = function (value) { return String(value || '').replace(/\s+/g, ' ').trim(); };
  const source = normalize(sourceText);
  const evidence = normalize(quote);
  return evidence.length >= 8 && source.indexOf(evidence) >= 0;
}

function outputJson_(body, status) {
  return ContentService.createTextOutput(JSON.stringify(Object.assign({ status: status || 200 }, body)))
    .setMimeType(ContentService.MimeType.JSON);
}

function safely_(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

// ===== Sheets.gs =====
/**
 * Google Sheets API read-only adapter. Both source ranges are fetched in one HTTP call.
 */
const SHEETS_BATCH_RANGES_ = Object.freeze([
  CONFIG.PROJECT_TAB + '!A1:Z1000',
  CONFIG.SCHEDULE_TAB + '!A1:Z1600'
]);

function readSourceData_() {
  return parseSheetsBatchResponse_(fetchSheetsBatchValues_());
}

function buildSheetsBatchGetUrl_() {
  const query = SHEETS_BATCH_RANGES_.map(function (range) {
    return 'ranges=' + encodeURIComponent(range);
  });
  query.push('majorDimension=ROWS');
  query.push('valueRenderOption=FORMATTED_VALUE');
  return 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(CONFIG.SHEET_ID) +
    '/values:batchGet?' + query.join('&');
}

function fetchSheetsBatchValues_() {
  const response = UrlFetchApp.fetch(buildSheetsBatchGetUrl_(), {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      Accept: 'application/json'
    }
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(formatSheetsApiError_(status, body));
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error('Google Sheets API values:batchGet 응답 JSON 파싱 실패: ' + String(error.message || error));
  }
}

function parseSheetsBatchResponse_(payload) {
  const ranges = payload && payload.valueRanges;
  if (!Array.isArray(ranges) || ranges.length !== SHEETS_BATCH_RANGES_.length) {
    const count = Array.isArray(ranges) ? ranges.length : 0;
    throw new Error('Google Sheets API values:batchGet 응답 범위 누락: 예상 ' +
      SHEETS_BATCH_RANGES_.length + '개, 수신 ' + count + '개');
  }
  return {
    projects: rowsToObjects_(ranges[0].values || []),
    schedules: rowsToObjects_(ranges[1].values || [])
  };
}

function formatSheetsApiError_(status, body) {
  let detail = String(body || '').trim();
  try {
    const parsed = JSON.parse(detail);
    if (parsed && parsed.error && parsed.error.message) detail = parsed.error.message;
  } catch (ignored) {
    // Non-JSON response bodies are retained for diagnostics.
  }
  if (!detail) detail = '응답 본문 없음';
  return 'Google Sheets API values:batchGet 실패 (HTTP ' + status + '): ' + detail.slice(0, 1000);
}

function findSheetProject_(projects, candidate) {
  const id = String(candidate.project_id || '').trim();
  if (id) {
    const byId = projects.find(function (p) { return String(p.ID || '').trim() === id; });
    if (byId) return byId;
  }
  const wantedName = normalizeName_(candidate.channel_name);
  const wantedUrl = normalizeUrl_(candidate.channel_url);
  return projects.find(function (p) {
    return (wantedName && normalizeName_(p['채널명']) === wantedName) ||
      (wantedUrl && normalizeUrl_(p.URL) === wantedUrl);
  }) || null;
}

function findMatchingSheetSchedule_(schedules, schedule) {
  const wantedProject = String(schedule.project_id || '').trim();
  const wantedStart = isoLocal_(schedule.start).slice(0, 16);
  return schedules.find(function (row) {
    return String(row['프로젝트ID'] || '').trim() === wantedProject &&
      isoLocal_(row['시작일시']).slice(0, 16) === wantedStart;
  }) || null;
}

// ===== Notion.gs =====
let NOTION_LAST_REQUEST_MS_ = 0;
let NOTION_RUN_DEADLINE_MS_ = 0;

const NOTION_MAX_RETRY_AFTER_SECONDS_ = 30;
const PLAUD_MAX_BLOCKS_PER_RECORD_ = CONFIG.MAX_BLOCKS_PER_RECORD;
const PLAUD_MAX_TEXT_CHARS_ = CONFIG.MAX_TRANSCRIPT_CHARS;

function setNotionRunDeadline_(deadlineMs) {
  NOTION_RUN_DEADLINE_MS_ = Number(deadlineMs || 0);
}

function clearNotionRunDeadline_() {
  NOTION_RUN_DEADLINE_MS_ = 0;
}

function ensureNotionRunTime_(requiredMs) {
  if (!NOTION_RUN_DEADLINE_MS_) return;
  if (Date.now() + Number(requiredMs || 0) < NOTION_RUN_DEADLINE_MS_) return;
  const error = new Error('PLAUD 실행 마감 시각에 도달했습니다. 남은 작업은 다음 실행에서 계속합니다.');
  error.code = 'PLAUD_DEADLINE';
  throw error;
}

function notionRequest_(method, path, payload) {
  const token = getSettings_().notionToken;
  if (!token) throw new Error('NOTION_TOKEN이 없습니다.');
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': CONFIG.NOTION_VERSION,
      'Content-Type': 'application/json'
    }
  };
  if (payload !== undefined && payload !== null) options.payload = JSON.stringify(payload);
  for (let attempt = 0; attempt < 2; attempt++) {
    ensureNotionRunTime_(2000);
    const elapsed = Date.now() - NOTION_LAST_REQUEST_MS_;
    if (elapsed < 350) {
      ensureNotionRunTime_(350 - elapsed + 2000);
      Utilities.sleep(350 - elapsed);
    }
    const response = UrlFetchApp.fetch(CONFIG.NOTION_API + path, options);
    NOTION_LAST_REQUEST_MS_ = Date.now();
    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code >= 200 && code < 300) return body ? JSON.parse(body) : {};
    if (code === 429 && attempt === 0) {
      const headers = response.getAllHeaders ? response.getAllHeaders() : {};
      const rawRetryAfter = Number(headers['Retry-After'] || headers['retry-after'] || 1);
      const retryAfter = Math.min(
        NOTION_MAX_RETRY_AFTER_SECONDS_,
        Math.max(1, isFinite(rawRetryAfter) ? Math.ceil(rawRetryAfter) : 1)
      );
      ensureNotionRunTime_(retryAfter * 1000 + 2000);
      Utilities.sleep(retryAfter * 1000);
      continue;
    }
    const error = new Error('Notion API ' + code + ': ' + body.slice(0, 1000));
    error.httpStatus = code;
    throw error;
  }
  throw new Error('Notion API 요청 재시도 실패');
}

function queryDataSource_(dataSourceId, body) {
  return notionRequest_('post', '/data_sources/' + dataSourceId + '/query', body || {});
}

function queryChangedPlaud_(after, startCursor, pageSize) {
  const body = {
    page_size: Math.max(1, Math.min(100, Number(pageSize || CONFIG.POLL_PAGE_SIZE))),
    filter: { timestamp: 'last_edited_time', last_edited_time: { after: after } },
    sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    result_type: 'page'
  };
  if (startCursor) body.start_cursor = startCursor;
  return queryDataSource_(CONFIG.DATABASES.PLAUD, body);
}

function getPage_(pageId) {
  return notionRequest_('get', '/pages/' + pageId);
}

function createBlockReadContext_(deadlineMs) {
  return {
    deadlineMs: Number(deadlineMs || NOTION_RUN_DEADLINE_MS_ || 0),
    blockCount: 0,
    maxBlocks: PLAUD_MAX_BLOCKS_PER_RECORD_,
    maxTextChars: PLAUD_MAX_TEXT_CHARS_,
    blocksTruncated: false,
    textTruncated: false
  };
}

function takeBlock_(context, block) {
  ensureNotionRunTime_(2000);
  if (context.blockCount >= context.maxBlocks) {
    context.blocksTruncated = true;
    return false;
  }
  context.blockCount++;
  return Boolean(block);
}

function isMeetingNotesBlock_(block) {
  return Boolean(block && (block.type === 'meeting_notes' || block.type === 'transcription'));
}

function meetingNotesValue_(block) {
  if (!isMeetingNotesBlock_(block)) return null;
  return block.meeting_notes || block.transcription || null;
}

function getBlock_(blockId) {
  return notionRequest_('get', '/blocks/' + blockId);
}

function getBlockTree_(blockId, depth, context) {
  if (!blockId || depth > CONFIG.MAX_BLOCK_DEPTH || context.blocksTruncated) return [];
  const root = getBlock_(blockId);
  if (!takeBlock_(context, root)) return [];
  const all = [root];
  if (root.has_children && !isMeetingNotesBlock_(root)) {
    all.push.apply(all, getBlockChildren_(root.id, depth + 1, context));
  }
  return all;
}

function getBlockChildren_(blockId, depth, context) {
  const readContext = context || createBlockReadContext_();
  if (depth > CONFIG.MAX_BLOCK_DEPTH || readContext.blocksTruncated) return [];
  let cursor = '';
  const all = [];
  do {
    ensureNotionRunTime_(2000);
    const suffix = '?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
    const page = notionRequest_('get', '/blocks/' + blockId + '/children' + suffix);
    const results = page.results || [];
    for (let i = 0; i < results.length; i++) {
      const block = results[i];
      if (!takeBlock_(readContext, block)) break;
      all.push(block);
      // 2026-03-11 meeting_notes는 일반 자식 순회가 아니라 payload의 섹션 ID를 직접 읽는다.
      if (block.has_children && !isMeetingNotesBlock_(block)) {
        all.push.apply(all, getBlockChildren_(block.id, depth + 1, readContext));
      }
      if (readContext.blocksTruncated) break;
    }
    cursor = !readContext.blocksTruncated && page.has_more ? page.next_cursor : '';
  } while (cursor && !readContext.blocksTruncated);
  return all;
}

function blockText_(block) {
  const value = block && block[block.type];
  if (!value) return '';
  if (Array.isArray(value.rich_text)) return value.rich_text.map(function (x) { return x.plain_text || ''; }).join('');
  if (isMeetingNotesBlock_(block) && Array.isArray(value.title)) {
    return value.title.map(function (x) { return x.plain_text || ''; }).join('');
  }
  if (block.type === 'child_page') return value.title || '';
  if (block.type === 'child_database') return value.title || '';
  return '';
}

function blocksTextWithLimit_(blocks, context) {
  const parts = [];
  let used = 0;
  for (let i = 0; i < blocks.length; i++) {
    const text = blockText_(blocks[i]);
    if (!text) continue;
    const separatorLength = parts.length ? 1 : 0;
    const remaining = context.maxTextChars - used - separatorLength;
    if (remaining <= 0) {
      context.textTruncated = true;
      break;
    }
    const part = text.length > remaining ? text.slice(0, remaining) : text;
    parts.push(part);
    used += separatorLength + part.length;
    if (part.length < text.length) {
      context.textTruncated = true;
      break;
    }
  }
  return parts.join('\n').trim();
}

function readPlaudRecord_(candidate, deadlineMs) {
  const page = getPage_(candidate.id);
  const context = createBlockReadContext_(deadlineMs);
  const blocks = getBlockChildren_(candidate.id, 0, context);
  const meetingNotesBlocks = blocks.filter(isMeetingNotesBlock_);
  let ready = true;
  let pendingReason = '';
  const sectionIds = [];

  meetingNotesBlocks.forEach(function (block) {
    const value = meetingNotesValue_(block) || {};
    if (value.status !== 'notes_ready') {
      ready = false;
      pendingReason = 'meeting_notes 상태: ' + String(value.status || 'unknown');
      return;
    }
    const children = value.children || {};
    let blockSectionCount = 0;
    ['summary_block_id', 'notes_block_id', 'transcript_block_id'].forEach(function (name) {
      const id = children[name];
      if (!id) return;
      blockSectionCount++;
      if (sectionIds.indexOf(id) < 0) sectionIds.push(id);
    });
    if (!blockSectionCount) {
      ready = false;
      pendingReason = 'meeting_notes 섹션 블록 ID가 아직 없습니다.';
    }
  });

  if (ready && meetingNotesBlocks.length) {
    for (let i = 0; i < sectionIds.length && !context.blocksTruncated; i++) {
      blocks.push.apply(blocks, getBlockTree_(sectionIds[i], 1, context));
    }
  }

  const title = plainProperty_(page.properties && page.properties['이름']);
  const recordingId = plainProperty_(page.properties && page.properties['Recording ID']);
  const recordedAt = plainProperty_(page.properties && page.properties['녹음일']);
  const body = blocksTextWithLimit_(blocks, context);
  return {
    id: page.id,
    url: page.url || candidate.url || '',
    title: title,
    recordingId: recordingId,
    recordedAt: recordedAt,
    lastEditedAt: page.last_edited_time || candidate.last_edited_time || candidate.lastEditedAt,
    text: body,
    ready: ready,
    pendingReason: pendingReason,
    blockCount: context.blockCount,
    truncated: context.blocksTruncated || context.textTruncated
  };
}

function findProjectPage_(projectId, channelName) {
  if (projectId) {
    const byId = queryDataSource_(CONFIG.DATABASES.PROJECTS, {
      page_size: 2,
      filter: { property: '프로젝트 ID', rich_text: { equals: projectId } }
    });
    if ((byId.results || []).length) return byId.results[0];
  }
  if (channelName) {
    const byName = queryDataSource_(CONFIG.DATABASES.PROJECTS, {
      page_size: 2,
      filter: { property: '채널명', title: { equals: channelName } }
    });
    if ((byName.results || []).length) return byName.results[0];
  }
  return null;
}

function findSchedulePage_(scheduleId) {
  const result = queryDataSource_(CONFIG.DATABASES.SCHEDULES, {
    page_size: 2,
    filter: { property: '일정 ID', rich_text: { equals: scheduleId } }
  });
  return (result.results || [])[0] || null;
}

const PLAUD_SCHEDULE_LOOKUP_CACHE_ = {};
const PLAUD_SCHEDULE_CLAIMS_ = {};

function plaudScheduleLookupKey_(recordKey, projectId) {
  return String(recordKey) + '|' + String(projectId);
}

function listPlaudSchedulesForRecord_(recordKey, projectId) {
  if (!recordKey || !projectId) return null;
  const cacheKey = plaudScheduleLookupKey_(recordKey, projectId);
  if (Object.prototype.hasOwnProperty.call(PLAUD_SCHEDULE_LOOKUP_CACHE_, cacheKey)) {
    return PLAUD_SCHEDULE_LOOKUP_CACHE_[cacheKey];
  }
  let cursor = '';
  const pages = [];
  do {
    const body = {
      page_size: 100,
      filter: { and: [
        { property: '프로젝트 ID', rich_text: { equals: projectId } },
        { property: '메모', rich_text: { contains: 'PLAUD Key: ' + recordKey } }
      ] }
    };
    if (cursor) body.start_cursor = cursor;
    const result = queryDataSource_(CONFIG.DATABASES.SCHEDULES, body);
    pages.push.apply(pages, result.results || []);
    cursor = result.has_more ? result.next_cursor : '';
    if (pages.length >= 300) break;
  } while (cursor);
  PLAUD_SCHEDULE_LOOKUP_CACHE_[cacheKey] = pages.slice(0, 300);
  return PLAUD_SCHEDULE_LOOKUP_CACHE_[cacheKey];
}

function claimPlaudSchedule_(recordKey, projectId, pageId) {
  if (!pageId) return false;
  const cacheKey = plaudScheduleLookupKey_(recordKey, projectId);
  if (!PLAUD_SCHEDULE_CLAIMS_[cacheKey]) PLAUD_SCHEDULE_CLAIMS_[cacheKey] = {};
  if (PLAUD_SCHEDULE_CLAIMS_[cacheKey][String(pageId)]) return false;
  PLAUD_SCHEDULE_CLAIMS_[cacheKey][String(pageId)] = true;
  return true;
}

function rememberCreatedPlaudSchedule_(recordKey, projectId, page) {
  if (!page || !page.id) return false;
  const cacheKey = plaudScheduleLookupKey_(recordKey, projectId);
  if (Object.prototype.hasOwnProperty.call(PLAUD_SCHEDULE_LOOKUP_CACHE_, cacheKey)) {
    const pages = PLAUD_SCHEDULE_LOOKUP_CACHE_[cacheKey];
    if (!pages.some(function (item) { return item.id === page.id; })) pages.push(page);
  }
  return claimPlaudSchedule_(recordKey, projectId, page.id);
}

function findPlaudScheduleForRecord_(recordKey, projectId, title, eventKey, allowLegacyMigration, startIso) {
  if (!recordKey || !projectId) return null;
  const cacheKey = plaudScheduleLookupKey_(recordKey, projectId);
  const claimed = PLAUD_SCHEDULE_CLAIMS_[cacheKey] || {};
  const pages = (listPlaudSchedulesForRecord_(recordKey, projectId) || []).filter(function (page) {
    return !claimed[String(page.id)];
  });
  const wantedStart = isoLocal_(startIso);
  if (wantedStart) {
    const startMatches = pages.filter(function (page) {
      return isoLocal_(plainProperty_(page.properties && page.properties['시작'])) === wantedStart;
    });
    if (startMatches.length === 1) return startMatches[0];
  }
  if (eventKey) {
    const eventMatches = pages.filter(function (page) {
      return String(plainProperty_(page.properties && page.properties['메모']) || '')
        .indexOf('PLAUD Event: ' + eventKey) >= 0;
    });
    if (eventMatches.length === 1) return eventMatches[0];
  }
  if (!allowLegacyMigration) return null;
  const wanted = normalizeName_(title);
  const titleMatches = pages.filter(function (page) {
    return wanted && normalizeName_(plainProperty_(page.properties && page.properties['일정명'])) === wanted;
  });
  return titleMatches.length === 1 ? titleMatches[0] : null;
}

function findOpsTask_(title, sourceUrl) {
  const filters = [{ property: '과제명', title: { equals: title } }];
  if (validHttpUrl_(sourceUrl)) filters.push({ property: '근거 회의', url: { equals: sourceUrl } });
  const result = queryDataSource_(CONFIG.DATABASES.OPS, {
    page_size: 2,
    filter: filters.length === 1 ? filters[0] : { and: filters }
  });
  return (result.results || [])[0] || null;
}

function createNotionPage_(dataSourceId, properties) {
  return notionRequest_('post', '/pages', {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: properties
  });
}

function updateNotionPage_(pageId, properties) {
  return notionRequest_('patch', '/pages/' + pageId, { properties: properties });
}

function queryScheduleWindow_(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso || startIso);
  const buffer = CONFIG.TRAVEL_BUFFER_MINUTES * 60000;
  const from = new Date(start.getTime() - buffer).toISOString();
  const to = new Date(end.getTime() + buffer).toISOString();
  let cursor = '';
  const pages = [];
  do {
    const body = {
      page_size: 100,
      filter: { and: [
        { property: '시작', date: { on_or_before: to } },
        { or: [
          { property: '종료', date: { on_or_after: from } },
          { and: [
            { property: '종료', date: { is_empty: true } },
            { property: '시작', date: { on_or_after: from } }
          ] }
        ] }
      ] },
      sorts: [{ property: '시작', direction: 'ascending' }]
    };
    if (cursor) body.start_cursor = cursor;
    const result = queryDataSource_(CONFIG.DATABASES.SCHEDULES, body);
    pages.push.apply(pages, result.results || []);
    cursor = result.has_more ? result.next_cursor : '';
    if (pages.length >= 300) break;
  } while (cursor);
  return pages.slice(0, 300);
}

// ===== Apply.gs =====
function applyAnalysis_(record, analysis, sourceData) {
  const report = { projects: [], ops: [], schedules: [], conflicts: [], confirmations: [] };
  (analysis.uncertainties || []).forEach(function (x) { if (x) report.confirmations.push(x); });

  (analysis.project_updates || []).forEach(function (update) {
    if (!evidencePresent_(record.text, update.evidence_quote)) {
      report.confirmations.push('프로젝트 업데이트 근거 확인 실패: ' + (update.channel_name || update.project_id || '이름 없음'));
      return;
    }
    const sheet = findSheetProject_(sourceData.projects, update);
    if (!sheet) {
      report.confirmations.push('프로젝트 식별 실패: ' + (update.channel_name || update.project_id || '이름 없음'));
      return;
    }
    const page = findProjectPage_(String(sheet.ID), String(sheet['채널명']));
    const sheetDate = parseLocalDate_(sheet['최근활동일']);
    const meetingDate = parseLocalDate_(record.recordedAt) || new Date(record.lastEditedAt || 0);
    const meetingIsNewer = meetingDate && sheetDate && Utilities.formatDate(meetingDate, CONFIG.TIMEZONE, 'yyyy-MM-dd') > Utilities.formatDate(sheetDate, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    const canUseMeetingFacts = meetingIsNewer && update.confidence === 'confirmed' && !update.needs_confirmation;
    const recentContent = canUseMeetingFacts && update.recent_update ? update.recent_update : String(sheet['최근내용'] || '');
    const activityDate = canUseMeetingFacts ? isoLocal_(record.recordedAt || record.lastEditedAt) : isoLocal_(sheet['최근활동일']);
    const stage = canUseMeetingFacts && update.stage ? update.stage : mapSheetStage_(sheet['상태']);
    const confirmation = Boolean(update.needs_confirmation) || Boolean(update.confirmation_note);
    const properties = {
      '채널명': titleProperty_(sheet['채널명']),
      '프로젝트 ID': textProperty_(sheet.ID),
      '담당자': selectProperty_(sheet['담당자'] || '미지정'),
      '진행단계': selectProperty_(stage),
      'PLAUD 반영일': dateProperty_(isoNow_()),
      '마지막 동기화': dateProperty_(isoNow_()),
      '관리시트': urlProperty_(CONFIG.SHEET_URL)
    };
    addIfPresent_(properties, '외부 담당자', sheet['외부담당자'], textProperty_);
    if (sheet['연락처']) properties['연락처'] = { phone_number: String(sheet['연락처']) };
    if (validHttpUrl_(sheet.URL)) properties['채널 URL'] = urlProperty_(sheet.URL);
    addIfPresent_(properties, '최근 활동일', activityDate, dateProperty_);
    addIfPresent_(properties, '최근 내용', recentContent, textProperty_);
    addIfPresent_(properties, '다음 행동', update.next_action || sheet['다음행동'], textProperty_);
    addIfPresent_(properties, 'PLAUD 보강 내용', update.plaud_enrichment || analysis.summary, textProperty_);
    if (validHttpUrl_(record.url)) properties['PLAUD 근거'] = urlProperty_(record.url);
    if (confirmation) properties['확인 필요'] = checkboxProperty_(true);
    addIfPresent_(properties, '상태 상세', update.confirmation_note, textProperty_);
    if (page) {
      const changed = changedProperties_(page, properties);
      if (Object.keys(changed).length) updateNotionPage_(page.id, changed);
    } else {
      createNotionPage_(CONFIG.DATABASES.PROJECTS, properties);
    }
    report.projects.push(String(sheet['채널명']));
    if (confirmation) report.confirmations.push(String(sheet['채널명']) + ': ' + (update.confirmation_note || '회의 내용 확인 필요'));
  });

  (analysis.ops_tasks || []).forEach(function (task) {
    if (!task.title) return;
    if (!evidencePresent_(record.text, task.evidence_quote)) {
      report.confirmations.push('운영과제 근거 확인 실패: ' + task.title);
      return;
    }
    if (!validHttpUrl_(record.url)) {
      report.confirmations.push('근거 URL이 없어 운영과제 자동 반영 보류: ' + task.title);
      return;
    }
    const existing = findOpsTask_(task.title, record.url);
    const status = task.needs_confirmation ? '확인 필요' : task.status;
    const properties = {
      '과제명': titleProperty_(task.title),
      '구분': selectProperty_(task.category),
      '근거 회의': urlProperty_(record.url),
      '상태': selectProperty_(status),
      '우선순위': selectProperty_(task.priority),
      '마지막 업데이트': dateProperty_(isoNow_())
    };
    addIfPresent_(properties, '담당', task.owner, textProperty_);
    addIfPresent_(properties, '마감', isoLocal_(task.due), dateProperty_);
    addIfPresent_(properties, '다음 행동', task.next_action, textProperty_);
    if (existing) {
      const changed = changedProperties_(existing, properties);
      if (Object.keys(changed).length) updateNotionPage_(existing.id, changed);
    } else {
      createNotionPage_(CONFIG.DATABASES.OPS, properties);
    }
    report.ops.push(task.title);
    if (task.needs_confirmation) report.confirmations.push('운영과제 확인: ' + task.title);
  });

  const scheduleContexts = (analysis.schedules || []).map(function (schedule) {
    const sheetProject = findSheetProject_(sourceData.projects, schedule);
    const title = schedule.title || (schedule.channel_name + ' 일정');
    return {
      schedule: schedule,
      sheetProject: sheetProject,
      eventGroupKey: sheetProject ? String(sheetProject.ID) + '|' + scheduleSourceFingerprint_(schedule) : '',
      titleGroupKey: sheetProject ? String(sheetProject.ID) + '|' + normalizeName_(title) : ''
    };
  });
  const scheduleEventTotals = {};
  const scheduleTitleTotals = {};
  scheduleContexts.forEach(function (context) {
    if (context.eventGroupKey) {
      scheduleEventTotals[context.eventGroupKey] = Number(scheduleEventTotals[context.eventGroupKey] || 0) + 1;
      context.occurrence = scheduleEventTotals[context.eventGroupKey];
    }
    if (context.titleGroupKey) {
      scheduleTitleTotals[context.titleGroupKey] = Number(scheduleTitleTotals[context.titleGroupKey] || 0) + 1;
    }
  });

  scheduleContexts.forEach(function (context) {
    const schedule = context.schedule;
    if (!evidencePresent_(record.text, schedule.evidence_quote)) {
      report.confirmations.push('일정 근거 확인 실패: ' + (schedule.title || schedule.channel_name));
      return;
    }
    const sheetProject = context.sheetProject;
    if (!sheetProject || !isoLocal_(schedule.start)) {
      report.confirmations.push('일정 식별/날짜 확인: ' + (schedule.title || schedule.channel_name));
      return;
    }
    schedule.project_id = String(sheetProject.ID);
    schedule.channel_name = String(sheetProject['채널명']);
    const sheetSchedule = findMatchingSheetSchedule_(sourceData.schedules, schedule);
    const recordKey = String(record.recordingId || record.id);
    const occurrence = Number(context.occurrence || 1);
    const eventKey = stableScheduleEventKey_(schedule, occurrence);
    const generatedId = stableScheduleId_(recordKey, schedule, eventKey);
    const sheetScheduleId = sheetSchedule ? String(sheetSchedule['일정ID']) : '';
    const startIso = isoLocal_(schedule.start);
    let existingSchedule = sheetScheduleId ? findSchedulePage_(sheetScheduleId) : null;
    if (!existingSchedule) existingSchedule = findSchedulePage_(generatedId);
    if (!existingSchedule) existingSchedule = findPlaudScheduleForRecord_(
      recordKey,
      schedule.project_id,
      schedule.title || (schedule.channel_name + ' 일정'),
      eventKey,
      scheduleTitleTotals[context.titleGroupKey] === 1,
      startIso
    );
    if (existingSchedule && !claimPlaudSchedule_(recordKey, schedule.project_id, existingSchedule.id)) {
      report.confirmations.push('일정 중복 식별 확인: ' + (schedule.title || schedule.channel_name) +
        ' — 같은 Notion 일정이 이번 회의에서 이미 사용되었습니다.');
      return;
    }
    const existingId = existingSchedule ? plainProperty_(existingSchedule.properties && existingSchedule.properties['일정 ID']) : '';
    const scheduleId = sheetScheduleId || existingId || generatedId;
    const endIso = isoLocal_(schedule.end) || startIso;
    const windowPages = queryScheduleWindow_(startIso, endIso);
    const conflicts = windowPages.filter(function (page) {
      if (existingSchedule && page.id === existingSchedule.id) return false;
      const status = plainProperty_(page.properties && page.properties['상태']);
      if (status === '완료' || status === '종료') return false;
      const existingOwner = plainProperty_(page.properties && page.properties['담당자']);
      const requestedOwner = schedule.owner || sheetProject['담당자'] || '';
      if (existingOwner && requestedOwner && existingOwner !== requestedOwner) return false;
      const start = plainProperty_(page.properties && page.properties['시작']);
      const end = plainProperty_(page.properties && page.properties['종료']) || start;
      const existingType = plainProperty_(page.properties && page.properties['유형']);
      const buffer = /온라인|전화/.test(String(schedule.type || '') + ' ' + String(existingType || '')) ? 0 : CONFIG.TRAVEL_BUFFER_MINUTES;
      return overlapWithBuffer_(startIso, endIso, start, end, buffer);
    });
    const hasConflict = conflicts.length > 0;
    const projectPage = findProjectPage_(schedule.project_id, schedule.channel_name);
    const properties = {
      '일정명': titleProperty_(schedule.title || (schedule.channel_name + ' 일정')),
      '일정 ID': textProperty_(scheduleId),
      '프로젝트 ID': textProperty_(schedule.project_id),
      '채널명': textProperty_(schedule.channel_name),
      '시작': dateProperty_(startIso),
      '종료': dateProperty_(endIso),
      '담당자': selectProperty_(schedule.owner || sheetProject['담당자'] || '미지정'),
      '상태': selectProperty_(hasConflict || schedule.needs_confirmation ? '확인 필요' : '예정'),
      '일정 충돌': checkboxProperty_(hasConflict),
      '메모': textProperty_('PLAUD Key: ' + recordKey + '\nPLAUD Event: ' + eventKey + '\nPLAUD 근거: ' + (record.url || record.id)),
      '관리시트': urlProperty_(CONFIG.SHEET_URL),
      '마지막 동기화': dateProperty_(isoNow_())
    };
    addIfPresent_(properties, '유형', schedule.type, textProperty_);
    if (hasConflict) properties['알림'] = textProperty_('일정 충돌·이동시간 확인');
    addIfPresent_(properties, '다음 행동', (hasConflict ? '앞뒤 일정과 이동·준비 시간 확인. ' : '') + (schedule.next_action || ''), textProperty_);
    if (projectPage) properties['프로젝트'] = { relation: [{ id: projectPage.id }] };
    if (existingSchedule) {
      const changed = changedProperties_(existingSchedule, properties);
      if (Object.keys(changed).length) updateNotionPage_(existingSchedule.id, changed);
    } else {
      const createdSchedule = createNotionPage_(CONFIG.DATABASES.SCHEDULES, properties);
      rememberCreatedPlaudSchedule_(recordKey, schedule.project_id, createdSchedule);
    }
    report.schedules.push(schedule.title || schedule.channel_name);
    if (hasConflict) report.conflicts.push((schedule.title || schedule.channel_name) + ' (' + startIso + ')');
    if (schedule.needs_confirmation) report.confirmations.push('일정 확인: ' + (schedule.title || schedule.channel_name));
  });
  return report;
}

// ===== Sync.gs =====
const SHEET_SYNC_STATE_PROPERTY_ = 'SHEET_SYNC_STATE_V2';
const SHEET_SYNC_RETRY_PROPERTY_ = 'SHEET_SYNC_RETRY_COUNT';
const SHEET_SYNC_MAX_TRANSIENT_RETRIES_ = 5;

function syncSheetToNotion() {
  const deadlineMs = Date.now() + CONFIG.RUN_BUDGET_MS;
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  let props = null;
  let state = { version: 2, phase: 'projects', afterId: '' };
  try {
    props = PropertiesService.getScriptProperties();
    state = normalizeSheetSyncState_(safely_(function () {
      return JSON.parse(props.getProperty(SHEET_SYNC_STATE_PROPERTY_) || 'null');
    }, null));
  } catch (error) {
    props = null;
  }

  if (!lock.tryLock(1000)) {
    if (props) {
      const retryCount = Number(props.getProperty(SHEET_SYNC_RETRY_PROPERTY_) || 0) + 1;
      props.setProperty(SHEET_SYNC_STATE_PROPERTY_, JSON.stringify(state));
      props.setProperty(SHEET_SYNC_RETRY_PROPERTY_, String(retryCount));
    }
    return { deferred: true, phase: state.phase, afterId: state.afterId };
  }

  lockAcquired = true;
  setNotionRunDeadline_(deadlineMs);
  try {
    validateSettings_();
    props.deleteProperty('SHEET_SYNC_STATE_V1');
    const sourceData = readSourceData_();
    state = normalizeSheetSyncState_(safely_(function () {
      return JSON.parse(props.getProperty(SHEET_SYNC_STATE_PROPERTY_) || 'null');
    }, null));
    const counts = { projectsCreated: 0, projectsUpdated: 0, schedulesCreated: 0, schedulesUpdated: 0, conflicts: [], invalidSchedules: [] };
    const projectPages = {};
    const projects = sourceData.projects.slice().sort(function (a, b) {
      return compareSyncId_(a.ID, b.ID);
    });
    const schedules = sourceData.schedules.slice().sort(function (a, b) {
      return compareSyncId_(a['일정ID'], b['일정ID']);
    });

    if (state.phase === 'projects') {
      for (let i = 0; i < projects.length; i++) {
        const row = projects[i];
        const projectId = String(row.ID || '').trim();
        if (!projectId || (state.afterId && compareSyncId_(projectId, state.afterId) <= 0)) continue;
        if (!hasPlaudRunTime_(deadlineMs, 15000)) {
          props.setProperty(SHEET_SYNC_STATE_PROPERTY_, JSON.stringify({ version: 2, phase: 'projects', afterId: state.afterId }));
          const retryCount = Number(props.getProperty(SHEET_SYNC_RETRY_PROPERTY_) || 0) + 1;
          props.setProperty(SHEET_SYNC_RETRY_PROPERTY_, String(retryCount));
          return { deferred: true, phase: 'projects', afterId: state.afterId, retryCount: retryCount };
        }
        const existing = findProjectPage_(projectId, row['채널명']);
        const desired = sheetProjectProperties_(row);
        if (existing && existing.properties) {
          const existingActivity = parseLocalDate_(plainProperty_(existing.properties['최근 활동일']));
          const sheetActivity = parseLocalDate_(row['최근활동일']);
          const hasPlaud = Boolean(plainProperty_(existing.properties['PLAUD 근거']));
          if (hasPlaud && existingActivity && sheetActivity && existingActivity.getTime() > sheetActivity.getTime()) {
            delete desired['최근 활동일'];
            delete desired['최근 내용'];
            delete desired['진행단계'];
          }
        }
        let page = existing;
        if (!existing) {
          desired['마지막 동기화'] = dateProperty_(isoNow_());
          page = createNotionPage_(CONFIG.DATABASES.PROJECTS, desired);
          counts.projectsCreated++;
        } else {
          const changed = changedProperties_(existing, desired);
          if (Object.keys(changed).length) {
            changed['마지막 동기화'] = dateProperty_(isoNow_());
            updateNotionPage_(existing.id, changed);
            counts.projectsUpdated++;
          }
        }
        projectPages[projectId] = page;
        state.afterId = projectId;
        props.setProperty(SHEET_SYNC_STATE_PROPERTY_, JSON.stringify({ version: 2, phase: 'projects', afterId: state.afterId }));
        props.deleteProperty(SHEET_SYNC_RETRY_PROPERTY_);
      }
      state.phase = 'schedules';
      state.afterId = '';
      props.setProperty(SHEET_SYNC_STATE_PROPERTY_, JSON.stringify(state));
      props.deleteProperty(SHEET_SYNC_RETRY_PROPERTY_);
    }

    for (let i = 0; i < schedules.length; i++) {
      const row = schedules[i];
      const scheduleId = String(row['일정ID'] || '').trim();
      if (!scheduleId || (state.afterId && compareSyncId_(scheduleId, state.afterId) <= 0)) continue;
      if (!hasPlaudRunTime_(deadlineMs, 15000)) {
        props.setProperty(SHEET_SYNC_STATE_PROPERTY_, JSON.stringify({ version: 2, phase: 'schedules', afterId: state.afterId }));
        const retryCount = Number(props.getProperty(SHEET_SYNC_RETRY_PROPERTY_) || 0) + 1;
        props.setProperty(SHEET_SYNC_RETRY_PROPERTY_, String(retryCount));
        return { deferred: true, phase: 'schedules', afterId: state.afterId, retryCount: retryCount };
      }
      if (!isoLocal_(row['시작일시'])) {
        counts.invalidSchedules.push(scheduleId + ': 시작일시 확인 필요');
        state.afterId = scheduleId;
        props.setProperty(SHEET_SYNC_STATE_PROPERTY_, JSON.stringify({ version: 2, phase: 'schedules', afterId: state.afterId }));
        props.deleteProperty(SHEET_SYNC_RETRY_PROPERTY_);
        continue;
      }
      const conflict = sheetScheduleHasConflict_(row, sourceData.schedules);
      if (conflict) counts.conflicts.push(String(row['채널명']) + ' ' + String(row['시작일시']));
      const projectId = String(row['프로젝트ID'] || '');
      const projectPage = projectPages[projectId] || findProjectPage_(projectId, row['채널명']);
      const desired = sheetScheduleProperties_(row, projectPage, conflict);
      const existing = findSchedulePage_(scheduleId);
      if (!existing) {
        desired['마지막 동기화'] = dateProperty_(isoNow_());
        createNotionPage_(CONFIG.DATABASES.SCHEDULES, desired);
        counts.schedulesCreated++;
      } else {
        const changed = changedProperties_(existing, desired);
        if (Object.keys(changed).length) {
          changed['마지막 동기화'] = dateProperty_(isoNow_());
          updateNotionPage_(existing.id, changed);
          counts.schedulesUpdated++;
        }
      }
      state.afterId = scheduleId;
      props.setProperty(SHEET_SYNC_STATE_PROPERTY_, JSON.stringify({ version: 2, phase: 'schedules', afterId: state.afterId }));
      props.deleteProperty(SHEET_SYNC_RETRY_PROPERTY_);
    }

    props.deleteProperty(SHEET_SYNC_STATE_PROPERTY_);
    props.deleteProperty(SHEET_SYNC_RETRY_PROPERTY_);
    props.setProperty('LAST_SHEET_SYNC', isoNow_());
    if (counts.projectsCreated || counts.projectsUpdated || counts.schedulesCreated || counts.schedulesUpdated || counts.conflicts.length || counts.invalidSchedules.length) {
      sendTelegramReport_([
        '원장→Notion 동기화 완료',
        '프로젝트 생성/갱신: ' + counts.projectsCreated + '/' + counts.projectsUpdated,
        '일정 생성/갱신: ' + counts.schedulesCreated + '/' + counts.schedulesUpdated,
        counts.conflicts.length ? '일정 충돌: ' + counts.conflicts.join(', ') : '',
        counts.invalidSchedules.length ? '확인 필요: ' + counts.invalidSchedules.join(', ') : ''
      ].filter(Boolean).join('\n'));
    }
    return counts;
  } catch (error) {
    if (isTransientSheetSyncError_(error)) {
      props = props || PropertiesService.getScriptProperties();
      props.setProperty(SHEET_SYNC_STATE_PROPERTY_, JSON.stringify(state));
      const retryCount = Number(props.getProperty(SHEET_SYNC_RETRY_PROPERTY_) || 0) + 1;
      if (retryCount <= SHEET_SYNC_MAX_TRANSIENT_RETRIES_) {
        props.setProperty(SHEET_SYNC_RETRY_PROPERTY_, String(retryCount));
        console.warn('원장 동기화 일시 오류로 재개 예약 (' + retryCount + '/' +
          SHEET_SYNC_MAX_TRANSIENT_RETRIES_ + '): ' + String(error && (error.message || error)));
        return { deferred: true, retryCount: retryCount };
      }
      props.deleteProperty(SHEET_SYNC_RETRY_PROPERTY_);
    }
    throw error;
  } finally {
    clearNotionRunDeadline_();
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

function normalizeSheetSyncState_(state) {
  if (!state || state.version !== 2 || (state.phase !== 'projects' && state.phase !== 'schedules')) {
    return { version: 2, phase: 'projects', afterId: '' };
  }
  return { version: 2, phase: state.phase, afterId: String(state.afterId || '') };
}

function compareSyncId_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function isTransientSheetSyncError_(error) {
  if (error && error.code === 'PLAUD_DEADLINE') return true;
  const message = String(error && (error.message || error) || '');
  const statusMatch = message.match(/(?:HTTP|API)\s*(\d{3})/i);
  const status = Number(error && error.httpStatus || (statusMatch ? statusMatch[1] : 0));
  if (status) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  return /timed?\s*out|temporar|service invoked too many times|address unavailable|internal error|재시도 실패/i.test(message);
}

function sheetProjectProperties_(row) {
  const stage = mapSheetStage_(row['상태']);
  const p = {
    '채널명': titleProperty_(row['채널명']),
    '프로젝트 ID': textProperty_(row.ID),
    '담당자': selectProperty_(row['담당자'] || '미지정'),
    '진행단계': selectProperty_(stage),
    '관리시트': urlProperty_(CONFIG.SHEET_URL)
  };
  addIfPresent_(p, '외부 담당자', row['외부담당자'], textProperty_);
  if (row['연락처']) p['연락처'] = { phone_number: String(row['연락처']) };
  if (validHttpUrl_(row.URL)) p['채널 URL'] = urlProperty_(row.URL);
  addIfPresent_(p, '최근 활동일', isoLocal_(row['최근활동일']), dateProperty_);
  addIfPresent_(p, '최근 내용', row['최근내용'], textProperty_);
  addIfPresent_(p, '다음 행동', row['다음행동'], textProperty_);
  addIfPresent_(p, '다음 일정', isoLocal_(row['다음일정']), dateProperty_);
  if (row['출처']) p['출처'] = selectProperty_(row['출처']);
  if (row['확인'] || stage === '확인 필요') p['확인 필요'] = checkboxProperty_(true);
  return p;
}

function sheetScheduleProperties_(row, projectPage, conflict) {
  const type = String(row['유형'] || '').trim();
  const channel = String(row['채널명'] || '').trim();
  const status = normalizeScheduleStatus_(row['상태'], conflict);
  const note = [row['장소'] ? '장소: ' + row['장소'] : '', row['메모/원본'] || ''].filter(Boolean).join('\n');
  const p = {
    '일정명': titleProperty_([channel, type].filter(Boolean).join(' · ') || String(row['일정ID'])),
    '일정 ID': textProperty_(row['일정ID']),
    '상태': selectProperty_(status),
    '시작': dateProperty_(isoLocal_(row['시작일시'])),
    '관리시트': urlProperty_(CONFIG.SHEET_URL)
  };
  addIfPresent_(p, '프로젝트 ID', row['프로젝트ID'], textProperty_);
  addIfPresent_(p, '채널명', channel, textProperty_);
  if (row['담당자']) p['담당자'] = selectProperty_(row['담당자']);
  addIfPresent_(p, '종료', isoLocal_(row['종료일시']), dateProperty_);
  addIfPresent_(p, '유형', type, textProperty_);
  addIfPresent_(p, '결과', row['결과'], textProperty_);
  addIfPresent_(p, '다음 행동', row['다음행동'], textProperty_);
  addIfPresent_(p, '메모', note, textProperty_);
  if (row['알림'] || conflict) p['알림'] = textProperty_(conflict ? '일정 충돌·이동시간 확인' : row['알림']);
  if (row['충돌'] || conflict) p['일정 충돌'] = checkboxProperty_(true);
  if (projectPage) p['프로젝트'] = { relation: [{ id: projectPage.id }] };
  return p;
}

function addIfPresent_(object, key, value, builder) {
  if (value !== '' && value !== null && value !== undefined) object[key] = builder(value);
}

function normalizeScheduleStatus_(value, conflict) {
  if (conflict) return '확인 필요';
  const s = String(value || '').replace(/\s/g, '');
  if (s === '확인필요') return '확인 필요';
  if (['예정', '완료', '확인 필요', '보류', '종료', '진행'].indexOf(String(value || '')) >= 0) return String(value);
  return '진행';
}

function sheetScheduleHasConflict_(target, rows) {
  if (/완료|종료/.test(String(target['상태'] || ''))) return Boolean(target['충돌']);
  if (!hasMeaningfulTime_(target['시작일시'])) return Boolean(target['충돌']);
  const start = isoLocal_(target['시작일시']);
  const end = isoLocal_(target['종료일시']) || start;
  return Boolean(target['충돌']) || rows.some(function (other) {
    if (other === target || !other['일정ID'] || !hasMeaningfulTime_(other['시작일시'])) return false;
    if (/완료|종료/.test(String(other['상태'] || ''))) return false;
    if (target['담당자'] && other['담당자'] && String(target['담당자']) !== String(other['담당자'])) return false;
    const buffer = /온라인|전화/.test(String(target['유형'] || '') + ' ' + String(other['유형'] || '')) ? 0 : CONFIG.TRAVEL_BUFFER_MINUTES;
    return overlapWithBuffer_(start, end, isoLocal_(other['시작일시']), isoLocal_(other['종료일시']) || isoLocal_(other['시작일시']), buffer);
  });
}

function hasMeaningfulTime_(value) {
  const m = String(value || '').match(/(?:T|\s)(\d{1,2}):(\d{2})/);
  return Boolean(m && (Number(m[1]) !== 0 || Number(m[2]) !== 0));
}

function changedProperties_(page, desired) {
  if (!page || !page.properties) return desired;
  const changed = {};
  Object.keys(desired).forEach(function (name) {
    if (!notionPropertyEquals_(page.properties[name], desired[name])) changed[name] = desired[name];
  });
  return changed;
}

function notionPropertyEquals_(current, desired) {
  if (!current) return false;
  if (Object.prototype.hasOwnProperty.call(desired, 'title')) return plainProperty_(current) === desired.title.map(function (x) { return x.text.content; }).join('');
  if (Object.prototype.hasOwnProperty.call(desired, 'rich_text')) return plainProperty_(current) === desired.rich_text.map(function (x) { return x.text.content; }).join('');
  if (Object.prototype.hasOwnProperty.call(desired, 'select')) return plainProperty_(current) === (desired.select ? desired.select.name : '');
  if (Object.prototype.hasOwnProperty.call(desired, 'checkbox')) return Boolean(plainProperty_(current)) === Boolean(desired.checkbox);
  if (Object.prototype.hasOwnProperty.call(desired, 'url')) return String(plainProperty_(current) || '') === String(desired.url || '');
  if (Object.prototype.hasOwnProperty.call(desired, 'phone_number')) return String(current.phone_number || '') === String(desired.phone_number || '');
  if (Object.prototype.hasOwnProperty.call(desired, 'date')) return String(plainProperty_(current) || '') === String(desired.date ? desired.date.start : '');
  if (Object.prototype.hasOwnProperty.call(desired, 'relation')) {
    const currentIds = (current.relation || []).map(function (x) { return x.id; }).sort().join(',');
    const desiredIds = (desired.relation || []).map(function (x) { return x.id; }).sort().join(',');
    return currentIds === desiredIds;
  }
  return false;
}

// ===== Telegram.gs =====
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

// ===== Core.gs =====
const PLAUD_SYNC_STATE_PROPERTY_ = 'PLAUD_SYNC_STATE_V2';
const PLAUD_RUN_LIMIT_MS_ = 4.5 * 60 * 1000;
const PLAUD_RECORD_START_RESERVE_MS_ = 90 * 1000;
const PLAUD_MAX_PROCESSED_PER_RUN_ = 3;
const PLAUD_MAX_CANDIDATES_PER_RUN_ = 25;
const PLAUD_MAX_PENDING_CANDIDATES_ = 25;
const PLAUD_PENDING_RETRY_MS_ = 10 * 60 * 1000;
const PLAUD_WAIT_PROPERTY_PREFIX_ = 'PLAUD_WAIT_';
const PLAUD_MAX_WAITERS_RESTORED_PER_RUN_ = 3;
const PLAUD_ERROR_RETRY_BASE_MS_ = 15 * 60 * 1000;
const PLAUD_ERROR_RETRY_MAX_MS_ = 24 * 60 * 60 * 1000;
const PLAUD_CHECKPOINT_OVERLAP_MS_ = 1;

function pollPlaudChanges() {
  console.log('pollPlaudChanges는 Mac mini 구독 런타임이 권한합니다. Apps Script는 수동 폴백 모드입니다.');
}

function hasPlaudRunTime_(deadlineMs, reserveMs) {
  return Date.now() + Number(reserveMs || 0) < Number(deadlineMs || 0);
}

function initialPlaudSyncState_(checkpoint) {
  return {
    version: 2,
    checkpoint: normalizePlaudCheckpoint_({ lastEditedAt: checkpoint || CONFIG.INITIAL_CHECKPOINT, pageId: '' }),
    scan: null,
    pending: []
  };
}

function loadPlaudSyncState_(props) {
  const raw = props.getProperty(PLAUD_SYNC_STATE_PROPERTY_);
  const parsed = safely_(function () { return raw ? JSON.parse(raw) : null; }, null);
  if (!parsed || parsed.version !== 2 || !parsed.checkpoint || !Array.isArray(parsed.pending)) {
    return initialPlaudSyncState_(props.getProperty('PLAUD_CHECKPOINT') || CONFIG.INITIAL_CHECKPOINT);
  }
  if (parsed.pending.length > PLAUD_MAX_PENDING_CANDIDATES_) {
    throw new Error('저장된 PLAUD 대기열이 상한을 초과했습니다: ' + parsed.pending.length);
  }
  parsed.checkpoint = normalizePlaudCheckpoint_(parsed.checkpoint);
  parsed.pending.forEach(function (item) {
    if (!item || !item.id || !item.lastEditedAt) {
      throw new Error('저장된 PLAUD 대기열 항목이 손상되었습니다.');
    }
  });
  if (parsed.scan) {
    parsed.scan.maxCheckpoint = normalizePlaudCheckpoint_(parsed.scan.maxCheckpoint || parsed.checkpoint);
    parsed.scan.cursor = parsed.scan.cursor || '';
  }
  return parsed;
}

function savePlaudSyncState_(props, state) {
  if (state.pending.length > PLAUD_MAX_PENDING_CANDIDATES_) {
    throw new Error('PLAUD 대기열 상한을 초과했습니다: ' + state.pending.length);
  }
  props.setProperty(PLAUD_SYNC_STATE_PROPERTY_, JSON.stringify(state));
  // 구버전 단일 체크포인트는 페이지 조회, 활성 후보, 개별 준비 대기가 모두 끝났을 때만 전진시킨다.
  if (!state.scan && state.pending.length === 0 && !hasStoredPlaudWaiters_(props)) {
    props.setProperty('PLAUD_CHECKPOINT', state.checkpoint.lastEditedAt);
  }
}

function normalizePlaudCheckpoint_(value) {
  const fallback = CONFIG.INITIAL_CHECKPOINT;
  const rawTime = value && value.lastEditedAt ? value.lastEditedAt : fallback;
  const time = new Date(rawTime);
  return {
    lastEditedAt: isNaN(time.getTime()) ? fallback : time.toISOString(),
    pageId: String(value && value.pageId || '')
  };
}

function comparePlaudCheckpoint_(left, right) {
  const a = normalizePlaudCheckpoint_(left);
  const b = normalizePlaudCheckpoint_(right);
  const timeDiff = new Date(a.lastEditedAt).getTime() - new Date(b.lastEditedAt).getTime();
  if (timeDiff !== 0) return timeDiff < 0 ? -1 : 1;
  if (a.pageId === b.pageId) return 0;
  return a.pageId < b.pageId ? -1 : 1;
}

function sortPendingPlaud_(pending) {
  pending.sort(function (a, b) {
    return comparePlaudCheckpoint_(
      { lastEditedAt: a.lastEditedAt, pageId: a.id },
      { lastEditedAt: b.lastEditedAt, pageId: b.id }
    );
  });
}

function pendingPlaudIndex_(pending, pageId) {
  for (let i = 0; i < pending.length; i++) {
    if (String(pending[i].id) === String(pageId)) return i;
  }
  return -1;
}

function plaudWaitPropertyKey_(pageId) {
  return PLAUD_WAIT_PROPERTY_PREFIX_ + hashText_(String(pageId)).slice(0, 32);
}

function hasStoredPlaudWaiters_(props) {
  const all = props.getProperties();
  return Object.keys(all).some(function (key) { return key.indexOf(PLAUD_WAIT_PROPERTY_PREFIX_) === 0; });
}

function normalizePlaudWaiter_(item) {
  if (!item || !item.id || !item.lastEditedAt) return null;
  return {
    id: String(item.id),
    lastEditedAt: normalizePlaudCheckpoint_({ lastEditedAt: item.lastEditedAt, pageId: item.id }).lastEditedAt,
    status: String(item.status || 'waiting'),
    retryAfter: Math.max(0, Number(item.retryAfter || 0)),
    reason: String(item.reason || '').slice(0, 500),
    attempts: Math.max(0, Number(item.attempts || 0)),
    readinessChecks: Math.max(0, Number(item.readinessChecks || 0)),
    httpStatus: item.httpStatus ? Number(item.httpStatus) : null,
    lastError: String(item.lastError || '').slice(0, 500),
    lastAttemptAt: String(item.lastAttemptAt || ''),
    waitingSince: String(item.waitingSince || item.lastAttemptAt || isoNow_())
  };
}

function upsertPlaudWaiter_(props, item) {
  const incoming = normalizePlaudWaiter_(item);
  if (!incoming) throw new Error('PLAUD 준비 대기 항목에 ID 또는 수정 시각이 없습니다.');
  const key = plaudWaitPropertyKey_(incoming.id);
  const existing = safely_(function () {
    const raw = props.getProperty(key);
    return raw ? normalizePlaudWaiter_(JSON.parse(raw)) : null;
  }, null);
  if (existing) {
    if (comparePlaudCheckpoint_(
      { lastEditedAt: existing.lastEditedAt, pageId: existing.id },
      { lastEditedAt: incoming.lastEditedAt, pageId: incoming.id }
    ) > 0) {
      incoming.lastEditedAt = existing.lastEditedAt;
    }
    incoming.attempts = Math.max(existing.attempts, incoming.attempts);
    incoming.readinessChecks = Math.max(existing.readinessChecks, incoming.readinessChecks);
    incoming.retryAfter = Math.max(existing.retryAfter, incoming.retryAfter);
    incoming.waitingSince = existing.waitingSince || incoming.waitingSince;
  }
  props.setProperty(key, JSON.stringify(incoming));
  return key;
}

function deletePlaudWaiter_(props, pageId) {
  props.deleteProperty(plaudWaitPropertyKey_(pageId));
}

function parkPlaudPending_(state, props, pendingIndex, waiter) {
  upsertPlaudWaiter_(props, waiter);
  let index = pendingIndex;
  if (!state.pending[index] || String(state.pending[index].id) !== String(waiter.id)) {
    index = pendingPlaudIndex_(state.pending, waiter.id);
  }
  if (index >= 0) state.pending.splice(index, 1);
  savePlaudSyncState_(props, state);
}

function migratePendingPlaudWaiters_(state, props) {
  const waiting = [];
  const active = [];
  state.pending.forEach(function (item) {
    if (item && (item.status === 'waiting' || item.status === 'error_wait' || item.status === 'not_found_wait')) {
      waiting.push(item);
    } else {
      active.push(item);
    }
  });
  if (!waiting.length) return 0;
  waiting.forEach(function (item) { upsertPlaudWaiter_(props, item); });
  state.pending = active;
  savePlaudSyncState_(props, state);
  return waiting.length;
}

function restoreDuePlaudWaiters_(state, props, maximum) {
  const slots = PLAUD_MAX_PENDING_CANDIDATES_ - state.pending.length;
  const limit = Math.min(Math.max(0, Number(maximum || 0)), slots);
  if (limit < 1) return 0;
  const now = Date.now();
  const all = props.getProperties();
  const due = Object.keys(all).filter(function (key) {
    return key.indexOf(PLAUD_WAIT_PROPERTY_PREFIX_) === 0;
  }).map(function (key) {
    const waiter = safely_(function () { return normalizePlaudWaiter_(JSON.parse(all[key])); }, null);
    return waiter ? { key: key, waiter: waiter } : null;
  }).filter(function (entry) {
    return entry && entry.waiter.retryAfter <= now;
  }).sort(function (left, right) {
    const retryDiff = left.waiter.retryAfter - right.waiter.retryAfter;
    if (retryDiff !== 0) return retryDiff;
    return comparePlaudCheckpoint_(
      { lastEditedAt: left.waiter.lastEditedAt, pageId: left.waiter.id },
      { lastEditedAt: right.waiter.lastEditedAt, pageId: right.waiter.id }
    );
  }).slice(0, limit);

  if (!due.length) return 0;
  due.forEach(function (entry) {
    const waiter = entry.waiter;
    const restored = Object.assign({}, waiter, { status: 'queued', retryAfter: 0 });
    const existingIndex = pendingPlaudIndex_(state.pending, restored.id);
    if (existingIndex >= 0) {
      const existing = state.pending[existingIndex];
      if (comparePlaudCheckpoint_(
        { lastEditedAt: restored.lastEditedAt, pageId: restored.id },
        { lastEditedAt: existing.lastEditedAt, pageId: existing.id }
      ) > 0) {
        state.pending[existingIndex] = restored;
      } else {
        existing.attempts = Math.max(Number(existing.attempts || 0), restored.attempts);
        existing.readinessChecks = Math.max(Number(existing.readinessChecks || 0), restored.readinessChecks);
      }
    } else {
      state.pending.push(restored);
    }
  });
  savePlaudSyncState_(props, state);
  due.forEach(function (entry) { props.deleteProperty(entry.key); });
  return due.length;
}

function plaudErrorRetryDelay_(attempts, httpStatus) {
  const exponent = Math.max(0, Math.min(8, Number(attempts || 1) - 1));
  const base = Number(httpStatus) === 404 ? PLAUD_ERROR_RETRY_BASE_MS_ * 4 : PLAUD_ERROR_RETRY_BASE_MS_;
  return Math.min(PLAUD_ERROR_RETRY_MAX_MS_, base * Math.pow(2, exponent));
}

function enqueuePlaudCandidate_(state, candidate) {
  const item = {
    id: String(candidate.id),
    lastEditedAt: normalizePlaudCheckpoint_({ lastEditedAt: candidate.last_edited_time, pageId: candidate.id }).lastEditedAt,
    status: 'queued',
    retryAfter: 0,
    reason: ''
  };
  const existingIndex = pendingPlaudIndex_(state.pending, item.id);
  if (existingIndex >= 0) {
    const existing = state.pending[existingIndex];
    if (comparePlaudCheckpoint_(
      { lastEditedAt: item.lastEditedAt, pageId: item.id },
      { lastEditedAt: existing.lastEditedAt, pageId: existing.id }
    ) > 0) {
      state.pending[existingIndex] = item;
    }
    return;
  }
  if (state.pending.length >= PLAUD_MAX_PENDING_CANDIDATES_) {
    throw new Error('PLAUD 대기열에 새 후보를 저장할 공간이 없습니다.');
  }
  state.pending.push(item);
}

function scanPlaudCandidates_(state, props, deadlineMs) {
  const availableSlots = PLAUD_MAX_PENDING_CANDIDATES_ - state.pending.length;
  const pageSize = Math.min(CONFIG.POLL_PAGE_SIZE, PLAUD_MAX_CANDIDATES_PER_RUN_, availableSlots);
  if (!hasPlaudRunTime_(deadlineMs, 15000)) return 0;
  if (pageSize < 1) return 0;

  if (!state.scan) {
    const checkpointMs = new Date(state.checkpoint.lastEditedAt).getTime();
    state.scan = {
      from: new Date(Math.max(0, checkpointMs - PLAUD_CHECKPOINT_OVERLAP_MS_)).toISOString(),
      cursor: '',
      maxCheckpoint: normalizePlaudCheckpoint_(state.checkpoint)
    };
  }

  const result = queryChangedPlaud_(state.scan.from, state.scan.cursor, pageSize);
  const candidates = (result.results || []).slice(0, PLAUD_MAX_CANDIDATES_PER_RUN_);
  candidates.forEach(function (candidate) {
    if (!candidate || !candidate.id || !candidate.last_edited_time) return;
    const tuple = { lastEditedAt: candidate.last_edited_time, pageId: candidate.id };
    if (comparePlaudCheckpoint_(tuple, state.checkpoint) <= 0) return;
    enqueuePlaudCandidate_(state, candidate);
    if (comparePlaudCheckpoint_(tuple, state.scan.maxCheckpoint) > 0) {
      state.scan.maxCheckpoint = normalizePlaudCheckpoint_(tuple);
    }
  });

  if (result.has_more) {
    if (!result.next_cursor) throw new Error('Notion 페이지네이션 응답에 next_cursor가 없습니다.');
    state.scan.cursor = result.next_cursor;
  } else {
    // 조회된 후보는 pending에 먼저 저장되어 있으므로, 워터마크를 전진해도 미처리 회의는 유실되지 않는다.
    state.checkpoint = normalizePlaudCheckpoint_(state.scan.maxCheckpoint);
    state.scan = null;
  }
  savePlaudSyncState_(props, state);
  return candidates.length;
}

function processedPropertyKey_(id) {
  return 'PROCESSED_PLAUD_' + hashText_(String(id)).slice(0, 32);
}

function isProcessed_(id, digest) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(processedPropertyKey_(id));
  if (raw) {
    const item = safely_(function () { return JSON.parse(raw); }, null);
    return Boolean(item && item.digest === String(digest));
  }
  const legacy = getProcessedMap_();
  return legacy[String(id)] === String(digest);
}

function rememberProcessed_(id, digest) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(processedPropertyKey_(id), JSON.stringify({ digest: String(digest), updatedAt: isoNow_() }));
  const all = props.getProperties();
  const keys = Object.keys(all).filter(function (key) { return key.indexOf('PROCESSED_PLAUD_') === 0 && key !== 'PROCESSED_PLAUD_HASHES'; });
  if (keys.length > 120) {
    keys.sort(function (a, b) {
      const av = safely_(function () { return JSON.parse(all[a]).updatedAt; }, '');
      const bv = safely_(function () { return JSON.parse(all[b]).updatedAt; }, '');
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    keys.slice(0, keys.length - 120).forEach(function (key) { props.deleteProperty(key); });
  }
}

function getProcessedMap_() {
  const raw = PropertiesService.getScriptProperties().getProperty('PROCESSED_PLAUD_HASHES') || '{}';
  return safely_(function () { return JSON.parse(raw); }, {});
}

function setupPollingTrigger() {
  setupAutomationTriggers_();
}

function setupAutomationTriggers() {
  return setupAutomationTriggers_(ScriptApp, PropertiesService);
}

function setupAutomationTriggers_(scriptApp, propertiesService) {
  const app = scriptApp || ScriptApp;
  const propsService = propertiesService || PropertiesService;
  const props = propsService && typeof propsService.getScriptProperties === 'function'
    ? propsService.getScriptProperties()
    : null;
  const handlers = ['pollPlaudChanges', 'syncSheetToNotion', 'continueSheetSync', 'processTelegramQueue'];
  app.getProjectTriggers().forEach(function (trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) >= 0) app.deleteTrigger(trigger);
  });
  console.log('Mac mini 구독 런타임이 자동 트리거 권한입니다. Apps Script는 수동 폴백 모드로 전환했습니다.');
}

function getAutomationTriggerInventory() {
  const inventory = {
    totalTriggers: 0,
    byHandler: {}
  };
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const handler = trigger.getHandlerFunction();
    inventory.totalTriggers++;
    if (!Object.prototype.hasOwnProperty.call(inventory.byHandler, handler)) {
      inventory.byHandler[handler] = 0;
    }
    inventory.byHandler[handler]++;
  });
  return inventory;
}

function healthCheck() {
  const settings = validateSettings_();
  const sourceData = readSourceData_();
  const notionSelf = notionRequest_('get', '/users/me');
  [CONFIG.DATABASES.PLAUD, CONFIG.DATABASES.PROJECTS, CONFIG.DATABASES.SCHEDULES, CONFIG.DATABASES.OPS]
    .forEach(function (id) { queryDataSource_(id, { page_size: 1 }); });
  const result = {
    ok: true,
    projectsRead: sourceData.projects.length,
    schedulesRead: sourceData.schedules.length,
    notionBot: notionSelf.name || notionSelf.id,
    notionDataSourcesShared: true,
    sheetWriteMethodsPresent: sourceContainsSheetWrites_()
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function sourceContainsSheetWrites_() {
  try {
    assertSheetsAdapterReadOnly_();
    return false;
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return true;
  }
}

function resetCheckpointForInitialRun() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PLAUD_SYNC_STATE_PROPERTY_);
  props.setProperty('PLAUD_CHECKPOINT', CONFIG.INITIAL_CHECKPOINT);
  console.log('체크포인트를 ' + CONFIG.INITIAL_CHECKPOINT + '로 설정했습니다.');
}

// ===== Tests.gs =====
function runUnitTests() {
  const tests = [
    function () { assertEqual_('원장-001', rowsToObjects_([['ID'], ['원장-001']])[0].ID, 'rowsToObjects'); },
    function () { assertEqual_('닥터딩요', normalizeName_(' 닥터 딩요! '), 'normalizeName'); },
    function () { assertEqual_('종료', mapSheetStage_('전화통화 · 거절'), 'stage 종료'); },
    function () { assertEqual_('확인 필요', mapSheetStage_('전화 · 답변대기'), 'stage 확인'); },
    function () { assertEqual_('예정', mapSheetStage_('회사방문 · 예정 · 확정'), 'stage 예정'); },
    function () { assertTrue_(overlapWithBuffer_('2026-08-19T13:00:00+09:00', '2026-08-19T14:00:00+09:00', '2026-08-19T15:00:00+09:00', '2026-08-19T16:00:00+09:00', 90), 'buffer conflict'); },
    function () { assertTrue_(!overlapWithBuffer_('2026-08-19T10:00:00+09:00', '2026-08-19T11:00:00+09:00', '2026-08-19T15:00:00+09:00', '2026-08-19T16:00:00+09:00', 90), 'no conflict'); },
    function () {
      const projects = [{ ID: '원장-016', '채널명': '닥터딩요', URL: 'https://youtube.com/@doctordinho' }];
      assertEqual_('원장-016', findSheetProject_(projects, { channel_name: '닥터 딩요' }).ID, 'project match');
    },
    function () {
      const id1 = stableScheduleId_('meeting-1', { project_id: '원장-016', title: '닥터딩요 내방 미팅', start: '2026-08-29 14:00' });
      const id2 = stableScheduleId_('meeting-1', { project_id: '원장-016', title: '닥터딩요 내방 미팅', start: '2026-08-29 15:00' });
      assertEqual_(id1, id2, 'stable schedule id');
    },
    function () {
      const schedule = { project_id: '원장-016', title: '정기 미팅' };
      const first = stableScheduleId_('meeting-1', schedule, stableScheduleEventKey_(schedule, 1));
      const second = stableScheduleId_('meeting-1', schedule, stableScheduleEventKey_(schedule, 2));
      assertTrue_(first !== second, 'same-title schedule occurrences must remain distinct');
    },
    function () {
      const before = { project_id: '원장-016', title: '정기 미팅', evidence_quote: '대표와 다음 미팅 일정을 확정했습니다.' };
      const renamed = { project_id: '원장-016', title: '후속 방문', evidence_quote: '대표와 다음 미팅 일정을 확정했습니다.' };
      assertEqual_(stableScheduleEventKey_(before, 1), stableScheduleEventKey_(renamed, 1),
        'source evidence keeps event key across title changes');
    },
    function () {
      assertTrue_(evidencePresent_('회의에서 8월 29일 오후 2시 미팅을 확정했다.', '8월 29일 오후 2시 미팅을 확정했다.'), 'evidence quote');
      assertTrue_(!evidencePresent_('회의에서 일정만 논의했다.', '8월 29일 오후 2시 미팅을 확정했다.'), 'missing evidence quote');
    },
    function () { assertEqual_('확인 필요', normalizeScheduleStatus_('확인필요', false), 'schedule status'); },
    function () {
      const rows = [
        { '일정ID': 'A', '시작일시': '2026-08-19 13:00', '종료일시': '2026-08-19 14:00', '담당자': '장우식' },
        { '일정ID': 'B', '시작일시': '2026-08-19 15:00', '종료일시': '2026-08-19 16:00', '담당자': '장우식' }
      ];
      assertTrue_(sheetScheduleHasConflict_(rows[1], rows), 'sheet schedule conflict');
    },
    function () {
      const rows = [
        { '일정ID': 'A', '시작일시': '2026-08-19 13:00', '종료일시': '2026-08-19 14:00', '담당자': '김동진' },
        { '일정ID': 'B', '시작일시': '2026-08-19 15:00', '종료일시': '2026-08-19 16:00', '담당자': '장우식' }
      ];
      assertTrue_(!sheetScheduleHasConflict_(rows[1], rows), 'different owner no conflict');
    },
    function () {
      const properties = sheetScheduleProperties_({
        '일정ID': 'S-EMPTY-END', '프로젝트ID': '원장-001', '채널명': '공빠TV',
        '시작일시': '2026-08-20 13:00', '종료일시': '', '상태': '예정'
      }, null, false);
      assertTrue_(!Object.prototype.hasOwnProperty.call(properties, '종료'), 'blank end must not clear Notion date');
    },
    function () {
      const url = buildSheetsBatchGetUrl_();
      const decoded = decodeURIComponent(url);
      assertEqual_(2, (url.match(/(?:[?&])ranges=/g) || []).length, 'batchGet range count');
      assertTrue_(decoded.indexOf('_프로젝트통합!A1:Z1000') >= 0, 'project range');
      assertTrue_(decoded.indexOf('_일정통합!A1:Z1600') >= 0, 'schedule range');
    },
    function () {
      const parsed = parseSheetsBatchResponse_({ valueRanges: [
        { values: [['ID', '채널명'], ['원장-001', '공빠TV']] },
        { values: [['일정ID', '프로젝트ID'], ['S-001', '원장-001']] }
      ] });
      assertEqual_('원장-001', parsed.projects[0].ID, 'batch project parse');
      assertEqual_('S-001', parsed.schedules[0]['일정ID'], 'batch schedule parse');
    },
    function () {
      assertSheetsAdapterReadOnly_();
    },
    function () {
      const fakePropertiesService = createFakePropertiesServiceForAutomationTriggers_({
        NOTION_TOKEN: 'notion-token-1'
      });
      withPatchedGlobal_('PropertiesService', fakePropertiesService, function () {
        const settings = validateSettings_();
        assertEqual_('notion-token-1', settings.notionToken, 'NOTION_TOKEN only validates');
      });
    },
    function () {
      let missing = false;
      withPatchedGlobal_(
        'PropertiesService',
        createFakePropertiesServiceForAutomationTriggers_({}),
        function () {
          try {
            validateSettings_();
          } catch (error) {
            missing = String(error.message).indexOf('NOTION_TOKEN') >= 0;
          }
        }
      );
      assertTrue_(missing, 'NOTION_TOKEN is required when no API key/model fallback exists');
    },
    function () {
      const fakePropertiesService = createFakePropertiesServiceForAutomationTriggers_({
        NOTION_TOKEN: 'notion-token-only',
        EXTRA_TOKEN: 'should-be-ignored-if-present'
      });
      withPatchedGlobal_('PropertiesService', fakePropertiesService, function () {
        const settings = validateSettings_();
        assertEqual_('notion-token-only', settings.notionToken, 'notion-token-only mode');
        assertEqual_('', settings.telegramBotToken, 'telegram token remains optional');
        assertEqual_('', settings.telegramAllowedChatId, 'telegram id remains optional');
        assertEqual_('', settings.webhookKey, 'webhook key remains optional');
      });
    },
    function () {
      const a = { lastEditedAt: '2026-08-18T00:00:00.000Z', pageId: 'aaa' };
      const b = { lastEditedAt: '2026-08-18T00:00:00.000Z', pageId: 'bbb' };
      assertTrue_(comparePlaudCheckpoint_(a, b) < 0, 'compound checkpoint page id');
    },
    function () {
      const block = { type: 'meeting_notes', meeting_notes: { status: 'notes_ready', children: { transcript_block_id: 'tx-1' } } };
      assertTrue_(isMeetingNotesBlock_(block), 'meeting notes block');
      assertEqual_('tx-1', meetingNotesValue_(block).children.transcript_block_id, 'meeting notes transcript id');
    },
    function () {
      const state = initialPlaudSyncState_('2026-08-17T10:40:44.000Z');
      enqueuePlaudCandidate_(state, { id: 'page-1', last_edited_time: '2026-08-18T00:00:00.000Z' });
      enqueuePlaudCandidate_(state, { id: 'page-1', last_edited_time: '2026-08-18T00:01:00.000Z' });
      assertEqual_(1, state.pending.length, 'candidate dedupe');
      assertEqual_('2026-08-18T00:01:00.000Z', state.pending[0].lastEditedAt, 'candidate update');
    },
    function () {
      assertEqual_('Google Sheets API values:batchGet 실패 (HTTP 403): 권한 없음',
        formatSheetsApiError_(403, '{"error":{"message":"권한 없음"}}'), 'sheets HTTP error');
    },
    function () {
      const syncSource = String(syncSheetToNotion);
      assertTrue_(syncSource.indexOf('return { deferred: true') >= 0, 'sync supports deferred/manual retry');
      assertTrue_(syncSource.indexOf('ScriptApp.newTrigger') < 0, 'sync does not create triggers');
      assertTrue_(syncSource.indexOf('scheduleSheetSyncContinuation_') < 0, 'sync has no continuation helper');
      assertTrue_(syncSource.indexOf('removeSheetSyncContinuationTriggers_') < 0, 'sync has no continuation cleanup helper');
    },
    function () {
      const fakeScriptApp = createFakeScriptAppForAutomationTriggers_();
      const fakePropertiesService = createFakePropertiesServiceForAutomationTriggers_({
        [SHEET_SYNC_STATE_PROPERTY_]: ''
      });
      const stalePoll = fakeScriptApp.addProjectTrigger_('pollPlaudChanges');
      const staleSync = fakeScriptApp.addProjectTrigger_('syncSheetToNotion');
      const staleContinuation = fakeScriptApp.addProjectTrigger_('continueSheetSync');
      fakeScriptApp.addProjectTrigger_('processTelegramQueue');
      fakeScriptApp.addProjectTrigger_('otherFunction');
      const staleSyncAgain = fakeScriptApp.addProjectTrigger_('syncSheetToNotion');

      setupAutomationTriggers_(fakeScriptApp, fakePropertiesService);

      const deleted = fakeScriptApp.getDeletedHandlers_();
      assertTrue_(deleted.indexOf('pollPlaudChanges') >= 0, 'setup deletes stale poll trigger');
      assertTrue_(deleted.indexOf('syncSheetToNotion') >= 0, 'setup deletes stale sync trigger');
      assertTrue_(deleted.indexOf('processTelegramQueue') >= 0, 'setup deletes stale queue trigger');
      assertTrue_(deleted.indexOf('continueSheetSync') >= 0, 'setup deletes stale continuation trigger');
      assertTrue_(deleted.indexOf('otherFunction') < 0, 'setup keeps unrelated triggers');
      assertTrue_(fakeScriptApp.getProjectTriggers_().indexOf(stalePoll) < 0, 'stale poll trigger removed');
      assertTrue_(fakeScriptApp.getProjectTriggers_().indexOf(staleSync) < 0, 'stale sync trigger removed');
      assertTrue_(fakeScriptApp.getProjectTriggers_().indexOf(staleContinuation) < 0, 'stale continuation trigger removed');
      assertTrue_(fakeScriptApp.getProjectTriggers_().indexOf(staleSyncAgain) < 0, 'stale duplicate sync trigger removed');

      const created = fakeScriptApp.getCreatedTriggers_();
      assertEqual_(0, created.length, 'no automation trigger builders for subscription-only mode');
    },
    function () {
      let lockRead = false;
      withPatchedGlobal_(
        'LockService',
        {
          getScriptLock: function () {
            lockRead = true;
            throw new Error('should not read lock service');
          }
        },
        function () {
          try {
            pollPlaudChanges();
          } catch (error) {
            assertTrue_(false, 'pollPlaudChanges should fail-closed before lock access');
          }
        }
      );
      assertTrue_(!lockRead, 'pollPlaudChanges fail-closed no lock access');
    },
    function () {
      let lockRead = false;
      withPatchedGlobal_(
        'LockService',
        {
          getScriptLock: function () {
            lockRead = true;
            throw new Error('should not read lock service');
          }
        },
        function () {
          try {
            processTelegramQueue();
          } catch (error) {
            assertTrue_(false, 'processTelegramQueue should fail-closed before lock access');
          }
        }
      );
      assertTrue_(!lockRead, 'processTelegramQueue fail-closed no lock access');
    },
    function () {
      let webhookError = false;
      try {
        setTelegramWebhook();
      } catch (error) {
        webhookError = String(error.message).indexOf('비활성화') >= 0;
      }
      assertTrue_(webhookError, 'setTelegramWebhook is disabled in fallback mode');
    },
    function () {
      assertEqual_('R2', normalizeSheetSyncState_({ version: 2, phase: 'schedules', afterId: 'R2' }).afterId,
        'sheet sync id checkpoint');
      assertEqual_('', normalizeSheetSyncState_({ phase: 'schedules', index: 8 }).afterId,
        'legacy index state restarts safely');
      assertTrue_(compareSyncId_('R2', 'R10') > 0, 'deterministic lexical sync ordering');
    },
    function () {
      const deadline = new Error('deadline');
      deadline.code = 'PLAUD_DEADLINE';
      const forbidden = new Error('Notion API 403: forbidden');
      forbidden.httpStatus = 403;
      assertTrue_(isTransientSheetSyncError_(deadline), 'deadline retry');
      assertTrue_(!isTransientSheetSyncError_(forbidden), 'permission error must not loop');
      assertTrue_(isTransientSheetSyncError_(new Error('Google Sheets API 실패 (HTTP 503)')), 'server error retry');
    },
    function () {
      const source = String(queryScheduleWindow_);
      assertTrue_(source.indexOf("on_or_after: from") >= 0, 'open-ended schedule lower bound');
      assertTrue_(source.indexOf("sorts: [{ property: '시작', direction: 'ascending' }]") >= 0,
        'schedule window ordering');
    },
    function () {
      const source = String(listPlaudSchedulesForRecord_);
      assertTrue_(source.indexOf('page_size: 100') >= 0 && source.indexOf('body.start_cursor = cursor') >= 0,
        'PLAUD schedule lookup pagination');
    },
    function () {
      const recordKey = 'claim-test-record';
      const projectId = 'claim-test-project';
      assertTrue_(claimPlaudSchedule_(recordKey, projectId, 'page-1'), 'first schedule claim');
      assertTrue_(!claimPlaudSchedule_(recordKey, projectId, 'page-1'), 'duplicate schedule claim rejected');
      PLAUD_SCHEDULE_LOOKUP_CACHE_[plaudScheduleLookupKey_(recordKey, projectId)] = [];
      assertTrue_(rememberCreatedPlaudSchedule_(recordKey, projectId, { id: 'page-2', properties: {} }),
        'created schedule claim');
      assertEqual_(1, PLAUD_SCHEDULE_LOOKUP_CACHE_[plaudScheduleLookupKey_(recordKey, projectId)].length,
        'created schedule cached');
    }
  ];
  tests.forEach(function (test) { test(); });
  console.log(tests.length + '개 단위 테스트 통과');
  return { ok: true, passed: tests.length };
}

function assertEqual_(expected, actual, label) {
  if (expected !== actual) throw new Error(label + ': expected=' + expected + ', actual=' + actual);
}

function assertTrue_(condition, label) {
  if (!condition) throw new Error(label + ': assertion failed');
}

function getGlobalRoot_() {
  if (typeof globalThis !== 'undefined') return globalThis;
  return (function () { return this; })();
}

function withPatchedGlobal_(name, value, fn) {
  const root = getGlobalRoot_();
  const hasOwn = root && Object.prototype.hasOwnProperty.call(root, name);
  const previous = root ? root[name] : undefined;
  if (!root) throw new Error('Global root unavailable in test runtime');
  root[name] = value;
  try { return fn(); } finally {
    if (hasOwn) {
      root[name] = previous;
    } else {
      delete root[name];
    }
  }
}

function assertSheetsAdapterReadOnly_() {
  const adapterSource = [
    readSourceData_,
    buildSheetsBatchGetUrl_,
    fetchSheetsBatchValues_,
    parseSheetsBatchResponse_,
    formatSheetsApiError_
  ].map(function (fn) { return String(fn); }).join('\n');
  const forbidden = /\bSpreadsheetApp\b|\.(?:setValue|setValues|appendRow|clear|clearContent|deleteRow|deleteRows|insertRow|insertRows|setFormula|setFormulas|setNote|setComment)\s*\(/;
  assertTrue_(!forbidden.test(adapterSource), 'Sheets adapter must remain read-only');
  assertTrue_(adapterSource.indexOf('ScriptApp.getOAuthToken()') >= 0, 'OAuth token usage');
  assertEqual_(1, (String(fetchSheetsBatchValues_).match(/UrlFetchApp\.fetch\s*\(/g) || []).length,
    'single HTTP fetch');
  assertEqual_(1, (String(buildSheetsBatchGetUrl_).match(/values:batchGet/g) || []).length,
    'single batchGet endpoint');
}

function createFakeScriptAppForAutomationTriggers_() {
  const projectTriggers = [];
  const deletedTriggers = [];
  const createdTriggers = [];
  const fakeScriptApp = {
    WeekDay: {
      MONDAY: 'MONDAY',
      TUESDAY: 'TUESDAY',
      WEDNESDAY: 'WEDNESDAY',
      THURSDAY: 'THURSDAY',
      FRIDAY: 'FRIDAY',
      SATURDAY: 'SATURDAY',
      SUNDAY: 'SUNDAY'
    },
    getProjectTriggers: function () {
      return projectTriggers.slice();
    },
    addProjectTrigger_: function (handler) {
      const trigger = { getHandlerFunction: function () { return handler; } };
      projectTriggers.push(trigger);
      return trigger;
    },
    getProjectTriggers_: function () {
      return projectTriggers.slice();
    },
    deleteTrigger: function (trigger) {
      const index = projectTriggers.indexOf(trigger);
      if (index >= 0) projectTriggers.splice(index, 1);
      deletedTriggers.push(trigger);
    },
    getCreatedTriggers_: function () {
      return createdTriggers.slice();
    },
    getDeletedHandlers_: function () {
      return deletedTriggers.map(function (trigger) {
        return trigger.getHandlerFunction();
      });
    }
  };
  return fakeScriptApp;
}

function createFakePropertiesServiceForAutomationTriggers_(properties) {
  const store = {};
  Object.keys(properties || {}).forEach(function (key) {
    store[key] = properties[key];
  });
  return {
    getScriptProperties: function () {
      return {
        getProperty: function (key) {
          return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : '';
        },
        setProperty: function (key, value) {
          store[key] = value;
        },
        deleteProperty: function (key) {
          delete store[key];
        },
        getProperties: function () {
          return JSON.parse(JSON.stringify(store));
        }
      };
    }
  };
}
