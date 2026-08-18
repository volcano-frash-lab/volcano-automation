# 볼케이노 자동화 빠른 시작

## 1. 개요

- Google Sheets는 읽기 전용입니다.
- PLAUD/Telegram 소스 정리는 macOS 런타임에서 담당합니다.
- Apps Script는 수동 폴백(`syncSheetToNotion`) 모드입니다.
- OpenAI 키/모델은 더 이상 사용하지 않습니다.
- external plaud_telegram_runtime.py -> analyze_codex / plaud_codex_agent.py via Codex CLI logged into a ChatGPT subscription -> private ledger analysis_summary -> repo volcano_notion_sync.py -> Notion.
- The state producer is external to this repo. Apps Script is inert/manual, installs no triggers, and requires only NOTION_TOKEN in Script Properties.

## 2. macOS 런타임 설치

```bash
cd /Users/ahnsungkwon/volcano-automation
./scripts/install_volcano_notion_sync.sh --dry-run
./scripts/install_volcano_notion_sync.sh
```

요구 조건:
- `~/Library/LaunchAgents/com.ari.volcano-notion-sync.plist` 존재
- `StartInterval = 900`
- `StartCalendarInterval`: Weekday 2~6, `08:30`

기본 배포 경로: `PLAUD_PRIVATE_ROOT/bin/volcano_notion_sync.py`

## 3. Script Properties

현재 Apps Script 실행에 필수인 값: `NOTION_TOKEN`

## 4. 배포

- 새 Apps Script 프로젝트 생성 후 번들(`VolcanoAutomation.bundle.gs`)만 붙여넣기
- 분리형 `.gs`는 함께 배포하지 않기

## 5. 실행 검사

```bash
npm run build
npm run validate
```

`npm run validate`는 내부적으로 Node 테스트, Python 테스트, `appsscript.json` 검증을 포함합니다.
