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
