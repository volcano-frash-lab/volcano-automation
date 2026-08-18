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
  const deadlineMs = Date.now() + PLAUD_RUN_LIMIT_MS_;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  setNotionRunDeadline_(deadlineMs);
  try {
    validateSettings_();
    const props = PropertiesService.getScriptProperties();
    const state = loadPlaudSyncState_(props);
    const reports = [];
    let processedCount = 0;
    let inspectedCount = 0;
    let sourceData = null;

    migratePendingPlaudWaiters_(state, props);
    restoreDuePlaudWaiters_(state, props, PLAUD_MAX_WAITERS_RESTORED_PER_RUN_);
    scanPlaudCandidates_(state, props, deadlineMs);
    sortPendingPlaud_(state.pending);

    let index = 0;
    while (
      index < state.pending.length &&
      processedCount < PLAUD_MAX_PROCESSED_PER_RUN_ &&
      inspectedCount < PLAUD_MAX_CANDIDATES_PER_RUN_
    ) {
      if (!hasPlaudRunTime_(deadlineMs, PLAUD_RECORD_START_RESERVE_MS_)) break;
      const pending = state.pending[index];
      if (pending.retryAfter && Number(pending.retryAfter) > Date.now()) {
        index++;
        continue;
      }

      inspectedCount++;
      try {
        const record = readPlaudRecord_(pending, deadlineMs);
        if (comparePlaudCheckpoint_(
          { lastEditedAt: record.lastEditedAt, pageId: record.id },
          { lastEditedAt: pending.lastEditedAt, pageId: pending.id }
        ) > 0) {
          pending.lastEditedAt = record.lastEditedAt;
        }

        if (!record.ready || !record.text || record.text.length < 40) {
          parkPlaudPending_(state, props, index, Object.assign({}, pending, {
            status: 'waiting',
            reason: record.pendingReason || (!record.text ? '회의 내용이 비어 있습니다.' : '회의 내용이 너무 짧습니다.'),
            retryAfter: Date.now() + PLAUD_PENDING_RETRY_MS_,
            readinessChecks: Number(pending.readinessChecks || 0) + 1,
            lastAttemptAt: isoNow_()
          }));
          continue;
        }

        const digest = hashText_([record.title, record.text, record.lastEditedAt].join('|'));
        if (isProcessed_(record.id, digest)) {
          deletePlaudWaiter_(props, pending.id);
          state.pending.splice(index, 1);
          savePlaudSyncState_(props, state);
          continue;
        }

        if (!sourceData) sourceData = readSourceData_();
        const analysis = analyzeMeeting_(record, sourceData);
        const report = applyAnalysis_(record, analysis, sourceData);
        rememberProcessed_(record.id, digest);
        reports.push(formatReport_(report, record.title));
        deletePlaudWaiter_(props, pending.id);
        state.pending.splice(index, 1);
        savePlaudSyncState_(props, state);
        processedCount++;
      } catch (error) {
        if (error && error.code === 'PLAUD_DEADLINE') throw error;
        const attempts = Number(pending.attempts || 0) + 1;
        const status = Number(error && error.httpStatus || 0);
        const message = String(error && (error.message || error) || '알 수 없는 PLAUD 처리 오류').slice(0, 500);
        parkPlaudPending_(state, props, index, Object.assign({}, pending, {
          status: status === 404 ? 'not_found_wait' : 'error_wait',
          reason: message,
          attempts: attempts,
          httpStatus: status || null,
          lastError: message,
          lastAttemptAt: isoNow_(),
          retryAfter: Date.now() + plaudErrorRetryDelay_(attempts, status)
        }));
        console.error('PLAUD 후보 격리 ' + pending.id + ' (시도 ' + attempts + '): ' + message);
      }
    }

    savePlaudSyncState_(props, state);
    if (reports.length) sendTelegramReport_(reports.join('\n\n').slice(0, 3900));
  } catch (error) {
    if (error && error.code === 'PLAUD_DEADLINE') {
      console.warn(error.message);
      return;
    }
    console.error(error && error.stack ? error.stack : error);
    throw error;
  } finally {
    clearNotionRunDeadline_();
    lock.releaseLock();
  }
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
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pollPlaudChanges') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('pollPlaudChanges').timeBased().everyMinutes(15).create();
  console.log('15분 증분 조회 트리거를 설정했습니다.');
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
  app.newTrigger('pollPlaudChanges').timeBased().everyMinutes(15).create();
  app.newTrigger('processTelegramQueue').timeBased().everyMinutes(1).create();
  const weekdays = [
    app.WeekDay.MONDAY,
    app.WeekDay.TUESDAY,
    app.WeekDay.WEDNESDAY,
    app.WeekDay.THURSDAY,
    app.WeekDay.FRIDAY
  ];
  weekdays.forEach(function (weekday) {
    app.newTrigger('syncSheetToNotion')
      .timeBased()
      .inTimezone(CONFIG.TIMEZONE)
      .onWeekDay(weekday)
      .atHour(8)
      .nearMinute(30)
      .everyWeeks(1)
      .create();
  });
  if (props && props.getProperty && props.getProperty(SHEET_SYNC_STATE_PROPERTY_)) {
    scheduleSheetSyncContinuation_();
  }
  console.log('PLAUD 15분 증분 조회, Telegram 1분 대기열 처리, 주중 08:30 원장 동기화 트리거를 설정했습니다.');
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
    openaiModel: settings.openaiModel,
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
