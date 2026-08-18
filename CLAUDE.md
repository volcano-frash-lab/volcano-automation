# Claude 작업 시작점

이 저장소에서 작업하기 전에 다음 파일을 순서대로 확인합니다.

1. `AGENTS.md` — 공통 안전·보안·테스트·배포 규칙
2. `ORCA_HANDOFF.md` — 현재 작업 상태와 다음 인계 내용
3. `README.md` — 현재 아키텍처(지금은 Apps Script 수동 폴백)와 운영 절차

Claude가 실제 연결되어 실행 결과가 확인된 경우만 작업자 목록에 기록합니다.

모든 변경은 `agent/<description>` 브랜치에서 수행하고 완료 전 `npm run validate`를 통과합니다.
Google Sheets는 항상 읽기 전용입니다.

OpenAI API는 앱 측에서 더 이상 사용하지 않으며, PLAUD/Telegram 자동 처리 트리거도 Apps Script에서 종료합니다.

external plaud_telegram_runtime.py -> analyze_codex / plaud_codex_agent.py via Codex CLI logged into a ChatGPT subscription -> private ledger analysis_summary -> repo volcano_notion_sync.py -> Notion.
The state producer is external to this repo. Apps Script is inert/manual, installs no triggers, and requires only NOTION_TOKEN in Script Properties.
