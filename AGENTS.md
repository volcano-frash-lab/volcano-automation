# 볼케이노 자동화 에이전트 협업 규칙

이 문서는 같은 GitHub 저장소에서 작업하는 Orca, Codex 및 연결된 보조 에이전트가 따라야 하는 공통 규칙이다. 사용자의 최신 지시와 명시된 write scope가 이 문서보다 우선한다.

## 작업 시작

1. 작업 전에 현재 브랜치와 작업 트리를 확인한다.
2. 기존 변경은 사용자 또는 다른 에이전트의 작업으로 간주하고 보존한다.
3. 새 작업 브랜치는 agent/<description> 형식을 사용한다.
   - description은 짧은 영문 소문자와 하이픈으로 작성한다.
   - 예: agent/telegram-queue-safety
4. 같은 파일을 다른 에이전트가 수정 중이면 ORCA_HANDOFF.md에서 범위와 담당자를 먼저 확인한다.
5. 사용자가 지정한 write scope 밖의 파일은 수정하지 않는다.

## Git 안전 규칙

- 사용자 변경을 덮어쓰거나 되돌리지 않는다.
- 승인 없이 git reset --hard, 강제 checkout, force push, 광범위한 파일 삭제를 실행하지 않는다.
- 관련 없는 변경을 커밋에 포함하지 않는다.
- 에이전트별 브랜치를 사용하고 한 브랜치를 여러 에이전트가 동시에 수정하지 않는다.
- 커밋은 한 가지 목적에 맞게 작게 유지한다.
- 충돌 해결 시 어느 쪽이 최신인지 추측하지 말고 인계 기록과 사용자 지시를 우선한다.

## 데이터 및 보안 규칙

### Google Sheets

- Google Sheets는 절대 읽기 전용이다.
- 셀, 범위, 탭, 서식, 메모, 수식, 필터 또는 권한을 생성·수정·삭제하지 않는다.
- Sheets API의 update, append, batchUpdate 계열과 SpreadsheetApp 쓰기 메서드를 사용하지 않는다.
- appsscript.json에는 spreadsheets.readonly OAuth scope만 유지하고 광범위한 spreadsheets 읽기·쓰기 scope를 추가하지 않는다.
- 현재 원장 조회는 OAuth 토큰과 Sheets API values:batchGet 방식이다.
- OpenAI API 키/모델은 앱 설정에서 더 이상 요구하지 않으며, 트리거 처리 자동 실행도 Apps Script에서 종료한다.

external plaud_telegram_runtime.py -> analyze_codex / plaud_codex_agent.py via Codex CLI logged into a ChatGPT subscription -> private ledger analysis_summary -> repo volcano_notion_sync.py -> Notion.
The state producer is external to this repo. Apps Script is inert/manual, installs no triggers, and requires only NOTION_TOKEN in Script Properties.

### 비밀정보

- API 키, 토큰, webhook secret, 채팅 ID 또는 자격 증명을 코드·문서·테스트 fixture·로그·커밋에 넣지 않는다.
- 실제 비밀값과 실제처럼 보이는 예시 토큰 형식도 작성하지 않는다.
- 로컬 환경은 커밋되지 않는 .env를 사용하고, Apps Script 운영 환경은 Script Properties를 사용한다.
- .env.example에는 변수명과 빈 값 또는 명백한 placeholder만 둔다.
- 로그와 오류 메시지에 Authorization 헤더나 요청 전체 payload를 출력하지 않는다.

## 테스트 규칙

변경 후 저장소 루트에서 다음 검증을 실행한다.

    npm run validate

이 명령은 번들을 다시 생성하고 분리형 소스·번들 단위 테스트와 매니페스트 JSON 검증을 수행한다. 네트워크·Google·Notion·Telegram 동작은 실제 자격 증명이 없는 로컬 테스트에서 성공했다고 주장하지 않는다. 실행하지 못한 검증은 인계 문서에 명확히 남긴다.

## Apps Script 배포 규칙

- 운영 Apps Script 프로젝트에는 VolcanoAutomation.bundle.gs 내용만 유일한 .gs 코드로 배포한다.
- Config.gs, Utils.gs, Sheets.gs, Notion.gs, Apply.gs, Sync.gs, Telegram.gs, Core.gs, Tests.gs는 개발용 분리 소스다.
- 번들과 분리형 .gs를 함께 배포하면 전역 선언이 중복되므로 절대 함께 올리지 않는다.
- appsscript.json은 코드 번들과 별도의 매니페스트로 적용한다.
- 분리형 소스가 변경되면 최종 배포 전에 번들을 다시 생성하고, 각 분리 파일이 정확히 한 번 포함됐는지 검증한다.
- clasp를 이용한 분리형 push는 개발 검증용으로만 취급하며 최종 운영 배포로 간주하지 않는다.

## 외부 에이전트 사용

- Claude와 Antigravity는 해당 도구가 현재 세션에 실제로 연결되어 있고 호출 결과를 확인할 수 있을 때만 사용한다.
- 연결되지 않은 Claude, Antigravity 또는 다른 에이전트가 작업하거나 검토했다고 주장하지 않는다.
- Orca가 작업을 분배하는 경우에도 실제 실행 주체, 변경 파일, 테스트 결과를 ORCA_HANDOFF.md에 기록한다.

## 작업 종료

1. 지정된 write scope 안의 파일만 변경됐는지 확인한다.
2. npm run validate와 필요한 정적 검사를 실행한다.
3. 비밀값과 Google Sheets 쓰기 호출이 없는지 확인한다.
4. 배포 대상이면 번들 단독 배포 규칙을 확인한다.
5. ORCA_HANDOFF.md 형식에 맞춰 변경, 테스트, 미검증 항목과 다음 작업을 전달한다.
