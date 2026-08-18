# 볼케이노 PLAUD → Notion 자동화

> ⚠️ 최종 배포에서는 VolcanoAutomation.bundle.gs만 유일한 .gs 코드 파일로 사용하세요.
>
> 번들과 Config.gs, Utils.gs, Sheets.gs, Notion.gs, OpenAI.gs, Apply.gs, Sync.gs, Telegram.gs, Core.gs, Tests.gs를 함께 올리면 전역 선언이 중복됩니다. appsscript.json은 별도의 Apps Script 매니페스트이며 함께 적용해야 합니다.

Google Sheets 원장을 읽기 전용 기준으로 삼아 PLAUD 회의록과 Telegram 요약을 검증하고, Notion 프로젝트·일정·운영과제를 증분 갱신하는 독립형 Google Apps Script입니다. ChatGPT의 Notion 데이터소스 조회 한도나 Notion Business 구독에 의존하지 않습니다.

## 데이터 흐름

1. Google Sheets API에서 프로젝트와 일정 원장을 읽습니다.
2. PLAUD 변경분 또는 인증된 Telegram 요약만 후보로 저장합니다.
3. OpenAI 구조화 출력으로 관련 프로젝트·운영과제·일정을 추출합니다.
4. 시트 기록과 날짜를 비교해 더 최신인 확정 사실만 Notion에 반영합니다.
5. 프로젝트 ID, 일정 ID, 과제명+근거 회의, SHA-256 처리 해시로 중복을 막습니다.

Google Sheets와 PLAUD 회의록 원문은 수정하지 않습니다.

## Google Sheets 읽기 전용 구조

Sheets.gs는 SpreadsheetApp을 사용하지 않습니다. ScriptApp.getOAuthToken()과 UrlFetchApp으로 Google Sheets API values:batchGet을 한 번 호출합니다.

- 프로젝트 범위: _프로젝트통합!A1:Z1000
- 일정 범위: _일정통합!A1:Z1600
- 값 표현: FORMATTED_VALUE
- OAuth 범위: https://www.googleapis.com/auth/spreadsheets.readonly
- HTTP 오류, JSON 파싱 실패, 범위 누락을 명시적인 오류로 처리
- 시트 쓰기 메서드 정적 가드 포함

## PLAUD 증분 처리

- 15분마다 마지막 수정 시각 이후 항목을 서버 측 필터로 조회
- 동일 수정 시각 누락 방지를 위해 수정 시각+페이지 ID 복합 체크포인트 사용
- Notion next_cursor를 저장해 여러 페이지를 다음 실행에서도 이어서 조회
- 후보 대기열과 워터마크를 Script Properties에 저장
- 실행당 후보 검사 최대 25건, 실제 회의 반영 최대 3건
- 준비되지 않은 회의는 10분 뒤 재확인
- meeting_notes와 호환 transcription 블록 지원
- notes_ready일 때 summary_block_id, notes_block_id, transcript_block_id를 직접 조회
- 회의당 최대 500블록, 텍스트 60,000자, 중첩 깊이 4
- 실행 시간 예산 안에 끝나지 않으면 상태를 보존하고 다음 실행에서 계속

시트가 회의록보다 최신이면 시트 사실관계를 유지하고 PLAUD는 전략과 다음 행동 보강에만 사용합니다.

## Telegram 인증 및 보조 대기열

Telegram 웹훅은 다음 두 조건을 모두 만족해야 합니다.

- URL의 WEBHOOK_KEY 일치
- 메시지의 chat ID가 TELEGRAM_ALLOWED_CHAT_ID와 일치

doPost는 외부 API를 길게 호출하지 않고 메시지를 먼저 Script Properties에 저장해 빠르게 응답합니다. processTelegramQueue 1분 트리거가 가장 오래된 항목 한 건을 처리합니다. PLAUD의 Notion 증분 조회가 원본 수집 경로이며 Telegram은 반영을 앞당기는 보조 경로입니다.

- Telegram 본문 최대 2,200자
- 대기열 최대 30건
- 메시지 ID와 해시로 중복 방지
- 실패 시 항목을 삭제하지 않고 시도 횟수·오류·시각 보존
- setWebhook은 max_connections=1로 설정
- 성공 후에만 처리 해시를 기록하고 대기열에서 삭제

Telegram 특성상 다른 봇이 보낸 개인 메시지를 새 봇으로 직접 전달하지 못할 수 있습니다. 그런 경우 PLAUD의 Notion 증분 조회 경로를 사용합니다.

Apps Script `ContentService` 응답은 임의의 실제 HTTP 오류 상태를 설정할 수 없으므로, 큐 저장 자체가 실패하면 Telegram이 재전송을 보장하지 않습니다. Telegram 수신까지 무손실이 필수라면 웹훅 수신부만 Cloud Run·Cloud Functions 같은 내구성 엔드포인트로 분리해야 합니다.

## 설치

### 1. Notion 내부 통합

Notion Settings → Connections/Integrations에서 내부 통합을 만들고 다음 데이터소스를 공유합니다.

- PLAUD 기록
- 볼케이노 프로젝트
- 볼케이노 일정
- 볼케이노 운영과제

토큰은 Apps Script의 스크립트 속성에 저장하고 채팅이나 소스 코드에 넣지 않습니다.

### 2. 최종 번들 배포

1. 새 독립형 Apps Script 프로젝트를 만듭니다.
2. 기본 Code.gs 하나에 VolcanoAutomation.bundle.gs 전체를 붙여넣습니다.
3. 다른 분리형 .gs 파일을 추가하지 않습니다.
4. appsscript.json 매니페스트를 적용합니다.
5. 필요한 스크립트 속성을 설정합니다.

| 키 | 필수 | 설명 |
|---|---:|---|
| NOTION_TOKEN | 예 | Notion 내부 통합 토큰 |
| OPENAI_API_KEY | 예 | 회의록 구조화용 API 키 |
| OPENAI_MODEL | 아니오 | 기본값 gpt-5.4-nano |
| TELEGRAM_BOT_TOKEN | Telegram 사용 시 | BotFather 토큰 |
| TELEGRAM_ALLOWED_CHAT_ID | Telegram 사용 시 | 허용할 단일 채팅 ID |
| TELEGRAM_REPORT_CHAT_ID | 아니오 | 결과 보고 채팅 ID |
| WEBHOOK_KEY | Telegram 사용 시 | 웹훅 URL 인증 키 |

### 3. 최초 실행 순서

1. runUnitTests — 현재 31개 테스트
2. healthCheck — Sheets·Notion·설정 검증
3. resetCheckpointForInitialRun — 초기 체크포인트 설정
4. setupAutomationTriggers — 15분/1분/월~금(총 5회) 08:30 트리거 설치 (자동화 카테고리 3개: PLAUD 증분 조회, Telegram 큐 처리, 원장 동기화)
   - 운영 전용 Google 계정으로 설치된 단일 트리거 소유권에서만 실행해야 하며, Orca 또는 Codex는 다른 계정에서 트리거 설치를 수행해선 안 됩니다.
   - 설치 결과는 총 7개 트리거(PLAUD 15분 1개, Telegram 1분 1개, syncSheetToNotion 월~금 5개)로 정규화되어야 합니다.
5. Telegram 사용 시 웹 앱 배포 후 setTelegramWebhook 실행

## 테스트와 안전 검증

로컬 분리형 소스와 배포 번들 검증:

    npm run validate

`npm run validate`는 분리형 소스에서 번들을 다시 생성한 뒤, 두 형태를 각각 Node VM으로 로드해 같은 테스트를 실행하고 매니페스트 JSON도 확인합니다.

현재 기준:

- 단위 테스트 31개 통과(분리형·번들 각각)
- Sheets 쓰기 API 0개
- SpreadsheetApp 0개
- Sheets API HTTP 호출 1회
- OAuth 범위 spreadsheets.readonly
- 분리형 각 파일은 번들에 정확히 한 번 포함
- `getAutomationTriggerInventory()`로 트리거 핸들러 카운트를 조회해 운영 소유 계정에서 총 7개 트리거가 맞는지 확인

## clasp 개발 배포

최종 사용자 배포는 번들 방식이 권장됩니다. 개발자가 분리형 파일로 clasp push를 수행할 때는 저장소의 .claspignore를 유지하세요.

.claspignore는 VolcanoAutomation.bundle.gs와 test-local.js를 제외하므로 분리형 소스와 번들이 동시에 업로드되는 것을 막습니다. clasp 분리형 배포에서는 번들을 별도로 추가하지 마세요.

## 운영 및 오류 처리

- Notion 429 응답은 Retry-After를 최대 30초까지 존중해 한 번 재시도합니다.
- 실행 마감이 가까우면 남은 PLAUD 작업을 상태에 보존하고 다음 실행에서 계속합니다.
- 원장 동기화는 프로젝트 ID·일정 ID 순서와 마지막 처리 ID를 저장해 행 정렬이 바뀌어도 안전하게 이어갑니다.
- 일시적 API 오류는 최대 5회까지 1분 continuation으로 재개하며 권한 오류는 무한 재시도하지 않습니다.
- 회의 내용이 비어 있거나 meeting_notes가 준비 전이면 처리 완료로 표시하지 않습니다.
- OpenAI 또는 Notion 반영 실패 시 처리 해시를 기록하지 않아 재처리할 수 있습니다.
- 일정은 앞뒤 90분 범위를 비교해 충돌과 촉박한 이동을 표시합니다.
- 대시보드의 연결된 데이터베이스 뷰는 데이터소스 갱신 후 자동 반영됩니다.
- OpenAI 요청은 시작 전에 실행시간을 확인하지만 Apps Script의 동기식 HTTP 요청을 중간에 취소할 수는 없습니다. 실행이 강제 종료돼도 처리 완료 해시를 쓰지 않아 다음 실행에서 재처리됩니다.

## 비용과 한도

Notion Business는 필요하지 않습니다. Notion 공개 API, Google Apps Script, OpenAI API를 사용합니다. OpenAI 비용은 새 회의 또는 새 Telegram 요약을 실제 분석할 때만 발생합니다.

## 오르카·Codex 공동 작업

이 폴더 하나를 동일한 GitHub 저장소로 사용합니다. 오르카와 Codex가 서로를 직접 호출하는 구조가 아니라, Git 브랜치·커밋·Pull Request를 통해 같은 작업 상태를 공유합니다.

1. 두 환경에서 같은 GitHub 저장소를 clone합니다.
2. 작업 전에 `AGENTS.md`와 `ORCA_HANDOFF.md`를 읽습니다.
3. 작업 브랜치는 `agent/<설명>` 형식으로 만듭니다.
4. 변경 후 `npm run validate`를 통과시킵니다.
5. Pull Request에서 GitHub Actions 검증을 확인한 뒤 병합합니다.

`.env`, `.clasp.json`, 토큰, 인증서와 개인 키는 저장소에 커밋하지 않습니다. Claude나 Antigravity는 해당 환경에 실제로 연결되어 있을 때만 실행 주체로 기록합니다.
