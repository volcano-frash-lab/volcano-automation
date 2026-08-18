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
