# 볼케이노 PLAUD → Notion 자동화

> ⚠️ 최종 배포에서는 `VolcanoAutomation.bundle.gs`만 사용하세요.
>
> `Config.gs`, `Utils.gs`, `Sheets.gs`, `Notion.gs`, `Apply.gs`, `Sync.gs`, `Telegram.gs`, `Core.gs`, `Tests.gs`는 개발용 분리 소스입니다.

## 현재 아키텍처

- Google Sheets는 **읽기 전용**으로만 사용합니다.
- PLAUD/Telegram 원문은 이제 macOS 구독 런타임에서 처리합니다.
- Apps Script는 수동 폴백입니다. `syncSheetToNotion`은 필요 시 수동 실행으로만 사용하고, 클라우드 자동 트리거는 보유하지 않습니다.
- Notion 반영은 macOS 런타임이 담당합니다.
- Notion 동기화와 PLAUD 반영은 `scripts/volcano_notion_sync.py`와 `scripts/tests/test_volcano_notion_sync.py`에서 관리합니다.
- 상태 연동: external plaud_telegram_runtime.py -> analyze_codex / plaud_codex_agent.py via Codex CLI logged into a ChatGPT subscription -> private ledger analysis_summary -> repo volcano_notion_sync.py -> Notion.
- The state producer is external to this repo. Apps Script is inert/manual, installs no triggers, and requires only NOTION_TOKEN in Script Properties.

## 데이터 플로우

1. macOS 런타임(`LaunchAgent`)이 PLAUD/Sheets 상태를 주기 수집합니다.
2. Notion projection idempotency/중복 해시로 안전하게 동기화합니다.
3. Apps Script는 수동으로 시트 동기화 트리거 없이 동작하도록 유지합니다.

## Apps Script 설정

`validateSettings_`는 `NOTION_TOKEN`만 필수입니다.

- `NOTION_TOKEN`은 Notion 통합 토큰입니다.
- OpenAI API 키/모델은 사용하지 않습니다.

## 트리거/웹훅 정책

- `pollPlaudChanges`, `processTelegramQueue`, `syncSheetToNotion`, `continueSheetSync` 관련 실행 트리거는 **생성하지 않습니다**.
- `setupPollingTrigger` / `setupAutomationTriggers` 실행 시 관련 트리거는 즉시 정리 후 종료합니다.
- `setTelegramWebhook`은 수동 폴백 모드에서 비활성화되며 HTTP 상태 변경을 수행하지 않습니다.

## 설치(스크립트)

### 1. macOS 런타임 배포

```bash
/usr/bin/env bash
./scripts/install_volcano_notion_sync.sh --dry-run   # 검증만
./scripts/install_volcano_notion_sync.sh            # 실제 복사
```

스크립트는 `~/Library/LaunchAgents/com.ari.volcano-notion-sync.plist`를 검증합니다.
- `StartInterval` = `900`
- `StartCalendarInterval` = 요일 2~6, `08:30`

동일 스크립트는 `PLAUD_PRIVATE_ROOT` 하위의 `bin/volcano_notion_sync.py`로 복사되며
`0600` 권한으로 배치됩니다.

### 2. 실행기 환경 파일

`volcano-sync-settings.json`(비공개 위치)에는 아래 키가 필요합니다.

- `spreadsheet_id`
- `projects_data_source_id`
- `schedule_data_source_id`
- `operations_data_source_id`
- `collaboration_sheet`(기본값: 협업리스트)
- `schedule_sheet`(기본값: 미팅스케쥴)

### 3. Apps Script 배포

- Google Apps Script 새 프로젝트 생성
- `VolcanoAutomation.bundle.gs`를 `Code.gs`에 붙여넣기
- 분리형 `.gs` 추가 배포 금지

## 테스트와 검증

### 로컬

```bash
npm run build
npm run test
/usr/bin/python3 -m unittest discover -s scripts/tests -p "test_*.py" -q
npm run validate
```

`npm run validate`는 다음 순서로 실행됩니다.
- `npm run build`
- Node Apps Script 테스트
- `scripts/tests` Python 테스트
- `appsscript.json` JSON 파싱 확인

## 보안 가이드

- 비밀은 `.env`나 문서에 기록하지 않습니다.
- `Scripts`, `launchctl`, `open` 동작은 외부에서 직접 실행하지 않습니다.
- 앱/스크립트는 네트워크 호출을 최소화하고, 실패 시 중복 없이 재시도 가능하도록 설계합니다.
