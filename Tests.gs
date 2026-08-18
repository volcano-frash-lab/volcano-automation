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
      assertTrue_(syncSource.indexOf('scheduleSheetSyncContinuation_();') >= 0, 'sync lock continuation');
      assertTrue_(syncSource.indexOf("const sourceData = readSourceData_();\n    props.deleteProperty(SHEET_SYNC_RETRY_PROPERTY_)") < 0,
        'retry count must survive until checkpoint progress');
      const continuationSource = String(scheduleSheetSyncContinuation_);
      assertTrue_(continuationSource.indexOf('SHEET_SYNC_CONTINUATION_AT_PROPERTY_') >= 0 &&
        continuationSource.indexOf('triggers.forEach') >= 0, 'leased single continuation trigger');
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
      assertEqual_(7, created.length, 'exact seven automation trigger builders');
      const countByHandler = {};
      created.forEach(function (trigger) {
        const handler = trigger.getHandlerFunction();
        if (!Object.prototype.hasOwnProperty.call(countByHandler, handler)) countByHandler[handler] = 0;
        countByHandler[handler]++;
      });
      assertEqual_(1, countByHandler.pollPlaudChanges, 'poll trigger count');
      assertEqual_(1, countByHandler.processTelegramQueue, 'telegram queue trigger count');
      assertEqual_(5, countByHandler.syncSheetToNotion, 'weekday sync trigger count');

      const pollTrigger = created.filter(function (trigger) { return trigger.getHandlerFunction() === 'pollPlaudChanges'; })[0];
      const queueTrigger = created.filter(function (trigger) { return trigger.getHandlerFunction() === 'processTelegramQueue'; })[0];
      assertEqual_(15, pollTrigger.everyMinutes, 'poll interval minutes');
      assertEqual_(1, queueTrigger.everyMinutes, 'queue interval minutes');
      assertTrue_(created.every(function (trigger) {
        return ['pollPlaudChanges', 'syncSheetToNotion', 'processTelegramQueue'].indexOf(trigger.getHandlerFunction()) >= 0;
      }), 'automation categories only');

      const syncTriggers = created.filter(function (trigger) { return trigger.getHandlerFunction() === 'syncSheetToNotion'; });
      const requiredWeekdays = [
        fakeScriptApp.WeekDay.MONDAY,
        fakeScriptApp.WeekDay.TUESDAY,
        fakeScriptApp.WeekDay.WEDNESDAY,
        fakeScriptApp.WeekDay.THURSDAY,
        fakeScriptApp.WeekDay.FRIDAY
      ];
      const coveredWeekdays = {};
      syncTriggers.forEach(function (trigger) {
        assertEqual_(1, trigger.everyWeeks, 'sync repeats weekly');
        assertEqual_(8, trigger.atHour, 'sync runs at 08:00 hour');
        assertEqual_(30, trigger.nearMinute, 'sync runs at minute 30');
        assertEqual_(CONFIG.TIMEZONE, trigger.timezone, 'sync uses configured timezone');
        coveredWeekdays[trigger.onWeekDay] = true;
      });
      requiredWeekdays.forEach(function (weekday) {
        assertTrue_(Object.prototype.hasOwnProperty.call(coveredWeekdays, weekday), 'weekday sync coverage ' + weekday);
      });
      assertEqual_(5, Object.keys(coveredWeekdays).length, 'exact 5 weekday schedules');
    },
    function () {
      const many = Array.from({ length: 30 }, function (_, index) { return { index: index }; });
      const bounded = limitMeetingAnalysisResult_({
        uncertainties: many,
        project_updates: many,
        ops_tasks: many,
        schedules: many
      });
      assertEqual_(OPENAI_RESULT_LIMITS_.uncertainties, bounded.uncertainties.length, 'uncertainty result cap');
      assertEqual_(OPENAI_RESULT_LIMITS_.projects, bounded.project_updates.length, 'project result cap');
      assertEqual_(OPENAI_RESULT_LIMITS_.ops, bounded.ops_tasks.length, 'ops result cap');
      assertEqual_(OPENAI_RESULT_LIMITS_.schedules, bounded.schedules.length, 'schedule result cap');
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
    newTrigger: function (handler) {
      const spec = {
        handler: handler
      };
      return {
        timeBased: function () {
          return this;
        },
        inTimezone: function (timezone) {
          spec.timezone = timezone;
          return this;
        },
        onWeekDay: function (weekday) {
          spec.onWeekDay = weekday;
          return this;
        },
        atHour: function (hour) {
          spec.atHour = hour;
          return this;
        },
        nearMinute: function (minute) {
          spec.nearMinute = minute;
          return this;
        },
        everyWeeks: function (weeks) {
          spec.everyWeeks = weeks;
          return this;
        },
        everyMinutes: function (minutes) {
          spec.everyMinutes = minutes;
          return this;
        },
        after: function (value) {
          spec.after = value;
          return this;
        },
        create: function () {
          const trigger = {
            getHandlerFunction: function () { return handler; },
            everyMinutes: spec.everyMinutes,
            everyWeeks: spec.everyWeeks,
            atHour: spec.atHour,
            nearMinute: spec.nearMinute,
            onWeekDay: spec.onWeekDay,
            timezone: spec.timezone,
            after: spec.after
          };
          createdTriggers.push(trigger);
          return trigger;
        }
      };
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
