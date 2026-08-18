const SHEET_SYNC_STATE_PROPERTY_ = 'SHEET_SYNC_STATE_V2';
const SHEET_SYNC_RETRY_PROPERTY_ = 'SHEET_SYNC_RETRY_COUNT';
const SHEET_SYNC_CONTINUATION_AT_PROPERTY_ = 'SHEET_SYNC_CONTINUATION_AT';
const SHEET_SYNC_MAX_TRANSIENT_RETRIES_ = 5;

function syncSheetToNotion() {
  const deadlineMs = Date.now() + CONFIG.RUN_BUDGET_MS;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    scheduleSheetSyncContinuation_();
    return { deferred: true };
  }
  setNotionRunDeadline_(deadlineMs);
  let props = null;
  try {
    validateSettings_();
    props = PropertiesService.getScriptProperties();
    props.deleteProperty('SHEET_SYNC_STATE_V1');
    const sourceData = readSourceData_();
    const state = normalizeSheetSyncState_(safely_(function () {
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
          scheduleSheetSyncContinuation_();
          return counts;
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
        scheduleSheetSyncContinuation_();
        return counts;
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
    removeSheetSyncContinuationTriggers_();
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
      const retryCount = Number(props.getProperty(SHEET_SYNC_RETRY_PROPERTY_) || 0) + 1;
      if (retryCount <= SHEET_SYNC_MAX_TRANSIENT_RETRIES_) {
        props.setProperty(SHEET_SYNC_RETRY_PROPERTY_, String(retryCount));
        scheduleSheetSyncContinuation_();
        console.warn('원장 동기화 일시 오류로 재개 예약 (' + retryCount + '/' +
          SHEET_SYNC_MAX_TRANSIENT_RETRIES_ + '): ' + String(error && (error.message || error)));
        return { deferred: true, retryCount: retryCount };
      }
      props.deleteProperty(SHEET_SYNC_RETRY_PROPERTY_);
      removeSheetSyncContinuationTriggers_();
    }
    throw error;
  } finally {
    clearNotionRunDeadline_();
    lock.releaseLock();
  }
}

function continueSheetSync() {
  syncSheetToNotion();
}

function scheduleSheetSyncContinuation_() {
  const leaseLock = LockService.getUserLock();
  if (!leaseLock.tryLock(5000)) return false;
  try {
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();
    const scheduledAt = Number(props.getProperty(SHEET_SYNC_CONTINUATION_AT_PROPERTY_) || 0);
    const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === 'continueSheetSync';
    });
    if (triggers.length === 1 && scheduledAt > now) return true;
    triggers.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
    ScriptApp.newTrigger('continueSheetSync').timeBased().after(60000).create();
    props.setProperty(SHEET_SYNC_CONTINUATION_AT_PROPERTY_, String(now + 60000));
    return true;
  } finally {
    leaseLock.releaseLock();
  }
}

function removeSheetSyncContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'continueSheetSync') ScriptApp.deleteTrigger(trigger);
  });
  PropertiesService.getScriptProperties().deleteProperty(SHEET_SYNC_CONTINUATION_AT_PROPERTY_);
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
