# Claude 작업 시작점

이 저장소에서 작업하기 전에 다음 파일을 순서대로 읽습니다.

1. `AGENTS.md` — 공통 안전·보안·테스트·배포 규칙
2. `ORCA_HANDOFF.md` — 현재 작업 상태와 다음 인계 내용
3. `README.md` — 시스템 구조와 운영 방법

Claude라는 이름은 실제 Claude 환경에서 이 저장소를 열고 작업할 때만 사용합니다. 현재 세션에 연결되지 않은 Claude가 검토하거나 수정했다고 기록하지 않습니다.

모든 변경은 `agent/<description>` 브랜치에서 수행하고 완료 전에 `npm run validate`를 통과시킵니다. Google Sheets는 항상 읽기 전용이며 토큰과 자격 증명을 커밋하지 않습니다.
