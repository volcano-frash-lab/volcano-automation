# 볼케이노 자동화 최종 배포

> ⚠️ 중요: Apps Script에는 VolcanoAutomation.bundle.gs만 배포하세요.
>
> Config.gs, Utils.gs, Sheets.gs 등 분리형 파일을 번들과 함께 올리면 함수와 상수가 중복되어 실행되지 않습니다. 기본 Code.gs 한 파일에 번들 전체를 붙여넣고, 다른 .gs 파일은 만들지 마세요. appsscript.json은 코드가 아닌 별도 매니페스트로 적용합니다.

## 1. Notion 연결

1. Notion에서 내부 통합을 만듭니다.
2. 통합에 다음 데이터소스 4개를 공유합니다.
   - PLAUD 기록
   - 볼케이노 프로젝트
   - 볼케이노 일정
   - 볼케이노 운영과제
3. 통합 토큰은 채팅에 보내지 말고 Apps Script 스크립트 속성에 저장합니다.

## 2. Apps Script 코드 배포

1. [Google Apps Script](https://script.google.com)에서 새 독립형 프로젝트를 만듭니다.
2. 기본 Code.gs 내용을 모두 지웁니다.
3. VolcanoAutomation.bundle.gs 전체를 Code.gs에 한 번 붙여넣고 저장합니다.
4. 프로젝트 설정에서 매니페스트 파일 표시를 켭니다.
5. appsscript.json 내용을 매니페스트에 붙여넣고 저장합니다.
6. 분리형 .gs 파일은 추가하지 않습니다.

## 3. 스크립트 속성

프로젝트 설정 → 스크립트 속성에 저장합니다.

| 키 | 필수 여부 | 용도 |
|---|---:|---|
| NOTION_TOKEN | 필수 | Notion 내부 통합 토큰 |
| OPENAI_API_KEY | 필수 | 회의록 구조화 |
| OPENAI_MODEL | 선택 | 기본값 gpt-5.4-nano |
| TELEGRAM_BOT_TOKEN | Telegram 사용 시 | BotFather 발급 토큰 |
| TELEGRAM_ALLOWED_CHAT_ID | Telegram 사용 시 필수 | 허용할 단일 채팅 ID |
| TELEGRAM_REPORT_CHAT_ID | 선택 | 처리 결과를 받을 채팅 ID |
| WEBHOOK_KEY | Telegram 사용 시 필수 | 웹훅 URL 인증용 긴 난수 |

## 4. 최초 실행

함수 선택 메뉴에서 아래 순서로 한 번씩 실행합니다.

1. runUnitTests — 현재 31개 테스트가 모두 통과해야 합니다.
2. healthCheck — Sheets·Notion 연결과 읽기 전용 가드를 확인합니다.
3. resetCheckpointForInitialRun — 초기 PLAUD 체크포인트를 설정합니다.
4. setupAutomationTriggers — 다음 트리거 3개를 만듭니다.
   - PLAUD 변경 조회: 15분마다
   - Telegram 내구성 대기열 처리: 1분마다
   - 원장→Notion 동기화: 월~금 08:30(총 5회)
   - 이 3개 카테고리는 총 7개 트리거 인스턴스로 구성되어야 합니다.
   - 작업용 Google 계정 하나가 sole owner로 설치해야 하며, Orca/Codex는 다른 계정에서 트리거 설치를 수행하지 않습니다.

최초 실행 시 Google Sheets 읽기, 외부 API 호출, 트리거 관리 권한을 승인합니다. Sheets 권한은 spreadsheets.readonly만 사용합니다.

## 5. Telegram 연결

1. Apps Script를 웹 앱으로 배포합니다. 실행 사용자는 본인으로 설정합니다.
2. setTelegramWebhook을 한 번 실행합니다.
3. 웹훅은 WEBHOOK_KEY와 TELEGRAM_ALLOWED_CHAT_ID가 모두 맞는 메시지만 받습니다.
4. 수신 요청에서는 AI·Notion 처리를 하지 않고 Script Properties 대기열에 먼저 저장합니다.
5. 1분 트리거가 가장 오래된 항목부터 처리하며 실패 항목은 오류와 시도 횟수를 보존합니다.

Telegram 요약 본문은 최대 2,200자, 대기열은 최대 30건입니다. 다른 봇의 개인 메시지는 Telegram 정책상 자동 전달되지 않을 수 있습니다. Apps Script 웹 앱은 큐 저장 실패 시 실제 non-2xx 응답을 보장하지 못하므로, Notion PLAUD 증분 조회를 원본 경로로 유지합니다.

## 현재 동작 요약

- Sheets: OAuth 토큰으로 values:batchGet 한 번을 호출해 _프로젝트통합!A1:Z1000과 _일정통합!A1:Z1600을 읽습니다. 쓰기 API는 없습니다.
- PLAUD: 마지막 수정 시각과 페이지 ID를 체크포인트로 사용하고 next_cursor 페이지네이션을 이어갑니다.
- meeting_notes: notes_ready가 될 때까지 보류하고 요약·노트·전사 섹션 블록을 읽습니다.
- 처리 제한: PLAUD 회의는 실행당 최대 3건이며 남은 후보는 다음 실행에서 계속됩니다.
- 검증: 로컬 및 Apps Script 단위 테스트는 현재 31개입니다.

## 오르카와 같은 GitHub 저장소 사용

1. 오르카에서 이 저장소를 clone하거나 기존 로컬 저장소를 엽니다.
2. 오르카 에이전트에게 먼저 `AGENTS.md`와 `ORCA_HANDOFF.md`를 읽도록 지시합니다.
3. `agent/<작업명>` 브랜치에서 수정합니다.
4. 완료 전에 `npm run validate`를 실행합니다.
5. GitHub Pull Request로 Codex 작업과 합칩니다.

오르카와 Codex는 GitHub를 통해 변경 내용을 공유합니다. 어느 한쪽에서 커밋하지 않은 로컬 변경은 다른 쪽에 자동으로 나타나지 않습니다.
