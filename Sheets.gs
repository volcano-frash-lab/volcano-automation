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
