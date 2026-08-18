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
