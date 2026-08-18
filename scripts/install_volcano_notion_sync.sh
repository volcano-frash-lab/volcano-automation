#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${1:-}" ]]; then
  echo "지원하지 않는 인자를 받았습니다: $1" >&2
  echo "사용법: $0 [--dry-run]" >&2
  exit 1
fi

PLAUD_PRIVATE_ROOT="${PLAUD_PRIVATE_ROOT:-$HOME/Library/Application Support/Ari/Plaud Intelligence}"
SOURCE_SCRIPT="$(cd "$(dirname "$0")" && pwd)/volcano_notion_sync.py"
LAUNCH_AGENT_PLIST="$HOME/Library/LaunchAgents/com.ari.volcano-notion-sync.plist"
TARGET_DIR="$PLAUD_PRIVATE_ROOT/bin"
TARGET_SCRIPT="$TARGET_DIR/volcano_notion_sync.py"

if [[ ! -f "$SOURCE_SCRIPT" ]]; then
  echo "원본 스크립트를 찾을 수 없습니다: $SOURCE_SCRIPT" >&2
  exit 2
fi

plutil_bin="/usr/bin/plutil"
plistbuddy_bin="/usr/libexec/PlistBuddy"

validate_launch_agent() {
  if [[ ! -f "$LAUNCH_AGENT_PLIST" ]]; then
    if (( DRY_RUN )) && [[ "${CI:-}" == "true" ]]; then
      echo "[dry-run] CI 환경에는 LaunchAgent plist가 없어 호스트 전용 검사를 건너뜁니다."
      return 0
    fi
    echo "LaunchAgent plist가 없습니다: $LAUNCH_AGENT_PLIST" >&2
    return 1
  fi

  if ! "$plutil_bin" -lint "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1; then
    echo "LaunchAgent plist 문법 오류: $LAUNCH_AGENT_PLIST" >&2
    return 1
  fi

  local start_interval
  start_interval=$("$plistbuddy_bin" -c 'Print :StartInterval' "$LAUNCH_AGENT_PLIST" 2>/dev/null || true)
  if [[ "$start_interval" != "900" ]]; then
    echo "StartInterval 값이 900이 아닙니다: ${start_interval:-없음}" >&2
    return 1
  fi

  local calendar_dump
  calendar_dump=$("$plistbuddy_bin" -c 'Print :StartCalendarInterval' "$LAUNCH_AGENT_PLIST" 2>/dev/null || true)
  if [[ -z "$calendar_dump" ]]; then
    echo "StartCalendarInterval 항목이 없습니다." >&2
    return 1
  fi

  local seen_weekdays=" "
  local expected=0
  local extra=0
  local invalid=0

  while IFS=' ' read -r day hour minute; do
    [[ -z "$day" ]] && continue
    case "$day" in
      2|3|4|5|6)
        if [[ "$seen_weekdays" == *" $day "* ]]; then
          extra=1
        fi
        seen_weekdays="${seen_weekdays}${day} "
        ;;
      *)
        extra=1
        ;;
    esac
    if [[ "$hour" != "8" || "$minute" != "30" ]]; then
      invalid=1
    fi
    expected=$((expected + 1))
  done < <(awk '
    /^[[:space:]]*Dict \{$/ { in_dict = 1; day=""; hour=""; minute=""; next }
    in_dict && /Weekday = / { day = $0; sub(/.*Weekday = /, "", day); gsub(/[^0-9]/, "", day); next }
    in_dict && /Hour = / { hour = $0; sub(/.*Hour = /, "", hour); gsub(/[^0-9]/, "", hour); next }
    in_dict && /Minute = / { minute = $0; sub(/.*Minute = /, "", minute); gsub(/[^0-9]/, "", minute); next }
    in_dict && /^[[:space:]]*}[[:space:]]*$/ {
      if (day != "") printf "%s %s %s\n", day, hour, minute;
      in_dict = 0;
      next
    }
  ' <<<"$calendar_dump")

  if (( expected == 0 )); then
    echo "유효한 StartCalendarInterval 항목을 읽지 못했습니다." >&2
    return 1
  fi

  if (( extra )) || (( invalid )); then
    echo "StartCalendarInterval 항목이 2~6 요일 08:30 규칙을 만족하지 않습니다." >&2
    return 1
  fi
  if (( expected != 5 )); then
    echo "StartCalendarInterval 항목 수가 5개가 아닙니다: ${expected}" >&2
    return 1
  fi
  for day in 2 3 4 5 6; do
    if [[ "$seen_weekdays" != *" $day "* ]]; then
      echo "StartCalendarInterval에서 Weekday ${day}가 없습니다." >&2
      return 1
    fi
  done

  return 0
}

copy_to_private_root() {
  if [[ ! -d "$TARGET_DIR" ]]; then
    if (( DRY_RUN )); then
      echo "[dry-run] mkdir -p \"$TARGET_DIR\" (권한: 700)"
    else
      mkdir -p "$TARGET_DIR"
      chmod 700 "$TARGET_DIR"
    fi
  fi

  if (( DRY_RUN )); then
    echo "[dry-run] install -m 600 \"$SOURCE_SCRIPT\" \"$TARGET_SCRIPT\""
    return 0
  fi

  install -m 600 "$SOURCE_SCRIPT" "$TARGET_SCRIPT"
  chmod 600 "$TARGET_SCRIPT"
}

validate_launch_agent
copy_to_private_root

echo "com.ari.volcano-notion-sync.plist 검증 및 동기화 준비가 완료되었습니다."
echo "대상 경로: $TARGET_SCRIPT"
if (( DRY_RUN )); then
  echo "dry-run 모드로 실제 복사하지 않았습니다."
fi
