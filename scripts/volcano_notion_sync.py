#!/usr/bin/env python3
"""Synchronize the Volcano collaboration sheet and PLAUD results to Notion.

The Google Sheet is read-only.  Notion writes are idempotent and are keyed by
stable project/schedule/source identifiers.  No transcript or contact data is
written to local logs or to the state file.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


DEFAULT_PRIVATE_ROOT = Path(
    os.environ.get(
        "PLAUD_PRIVATE_ROOT",
        str(Path.home() / "Library/Application Support/Ari/Plaud Intelligence"),
    )
)
DEFAULT_SETTINGS = DEFAULT_PRIVATE_ROOT / "volcano-sync-settings.json"
DEFAULT_STATE = DEFAULT_PRIVATE_ROOT / "volcano-sync-state.json"
DEFAULT_TOKEN = Path.home() / ".config/notion/api_key"
NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2025-09-03"
SYNC_SCHEMA_VERSION = "2"
MAX_TEXT = 1900
DATE_PATTERN = re.compile(r"(?<!\d)(20\d{2})[.\-/년 ]+(\d{1,2})[.\-/월 ]+(\d{1,2})")


class SyncError(RuntimeError):
    """A safe, non-content-bearing workflow error."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ProjectRow:
    project_id: str
    channel: str
    url: str
    owner: str
    external_owner: str
    contact: str
    latest_date: str | None
    latest_note: str
    activities: tuple[tuple[str, str, int], ...]


@dataclass(frozen=True)
class CalendarEvent:
    event_id: str
    starts_at: str
    event_date: str
    name: str


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _today() -> str:
    return date.today().isoformat()


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "").strip()[:limit]


def _sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(value, target, ensure_ascii=False, indent=2, sort_keys=True)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


def load_json(path: Path, default: Mapping[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return dict(default)
    return dict(value) if isinstance(value, Mapping) else dict(default)


def load_settings(path: Path = DEFAULT_SETTINGS) -> dict[str, Any]:
    value = load_json(path, {})
    required = (
        "spreadsheet_id",
        "projects_data_source_id",
        "schedule_data_source_id",
        "operations_data_source_id",
    )
    if not value.get("enabled") or any(not _text(value.get(key)) for key in required):
        raise SyncError("settings_invalid")
    return value


def _notion_token(path: Path = DEFAULT_TOKEN) -> str:
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        raise SyncError("notion_token_missing") from None
    if not token:
        raise SyncError("notion_token_missing")
    return token


class NotionClient:
    def __init__(self, token_path: Path = DEFAULT_TOKEN, timeout: int = 30):
        self.token = _notion_token(token_path)
        self.timeout = timeout

    def request(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> dict[str, Any]:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            NOTION_API + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code in {401, 403, 404}:
                raise SyncError("notion_access_denied") from None
            if error.code == 429:
                raise SyncError("notion_rate_limited") from None
            raise SyncError("notion_request_failed") from None
        except (OSError, ValueError, json.JSONDecodeError):
            raise SyncError("notion_request_failed") from None
        if not isinstance(payload, Mapping):
            raise SyncError("notion_response_invalid")
        return dict(payload)

    def pages(self, data_source_id: str) -> list[dict[str, Any]]:
        pages: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            body: dict[str, Any] = {"page_size": 100}
            if cursor:
                body["start_cursor"] = cursor
            payload = self.request("POST", f"/data_sources/{data_source_id}/query", body)
            results = payload.get("results")
            if not isinstance(results, list):
                raise SyncError("notion_response_invalid")
            pages.extend(item for item in results if isinstance(item, dict))
            if not payload.get("has_more"):
                return pages
            cursor = _text(payload.get("next_cursor"))
            if not cursor:
                raise SyncError("notion_response_invalid")

    def create(self, data_source_id: str, properties: Mapping[str, Any]) -> dict[str, Any]:
        return self.request(
            "POST",
            "/pages",
            {"parent": {"type": "data_source_id", "data_source_id": data_source_id}, "properties": properties},
        )

    def update(self, page_id: str, properties: Mapping[str, Any]) -> dict[str, Any]:
        return self.request("PATCH", f"/pages/{page_id}", {"properties": properties})


def notion_value(page: Mapping[str, Any], name: str) -> Any:
    properties = page.get("properties")
    prop = properties.get(name) if isinstance(properties, Mapping) else None
    if not isinstance(prop, Mapping):
        return None
    kind = prop.get("type")
    if not isinstance(kind, str) or not isinstance(prop.get(kind), (str, list, dict)):
        for candidate in ("title", "rich_text", "select", "status", "date", "relation", "checkbox", "url", "phone_number"):
            if candidate in prop:
                kind = candidate
                break
    value = prop.get(kind) if isinstance(kind, str) else None
    if kind in {"title", "rich_text"} and isinstance(value, list):
        parts = []
        for item in value:
            if not isinstance(item, Mapping):
                continue
            candidate = item.get("plain_text")
            if not candidate and isinstance(item.get("text"), Mapping):
                candidate = item.get("text", {}).get("content")
            parts.append(_text(candidate, 10000))
        return "".join(parts)
    if kind in {"select", "status"} and isinstance(value, Mapping):
        return _text(value.get("name"))
    if kind == "date" and isinstance(value, Mapping):
        return _text(value.get("start")) or None
    if kind == "relation" and isinstance(value, list):
        return [_text(item.get("id")) for item in value if isinstance(item, Mapping)]
    return value


def title(value: str) -> dict[str, Any]:
    return {"title": [{"type": "text", "text": {"content": _text(value)}}]}


def rich(value: str | None) -> dict[str, Any]:
    text = _text(value)
    return {"rich_text": [] if not text else [{"type": "text", "text": {"content": text}}]}


def select(value: str | None) -> dict[str, Any]:
    text = _text(value, 100)
    return {"select": None if not text else {"name": text}}


def date_value(value: str | None) -> dict[str, Any]:
    return {"date": None if not value else {"start": value}}


def parse_date(value: str) -> str | None:
    match = DATE_PATTERN.search(str(value or "").replace("..", "."))
    if not match:
        digits = re.sub(r"\D", "", str(value or ""))
        if len(digits) == 8 and digits.startswith("20"):
            parts = (digits[:4], digits[4:6], digits[6:])
        else:
            return None
    else:
        parts = match.groups()
    try:
        return date(int(parts[0]), int(parts[1]), int(parts[2])).isoformat()
    except ValueError:
        return None


def sheet_csv_url(spreadsheet_id: str, tab: str) -> str:
    return (
        f"https://docs.google.com/spreadsheets/d/{urllib.parse.quote(spreadsheet_id, safe='')}"
        f"/gviz/tq?tqx=out:csv&sheet={urllib.parse.quote(tab)}"
    )


def fetch_csv(url: str, timeout: int = 30) -> tuple[list[list[str]], bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": "Ari-Volcano-Sync/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except (OSError, urllib.error.HTTPError):
        raise SyncError("sheet_read_failed") from None
    try:
        rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    except UnicodeError:
        raise SyncError("sheet_format_invalid") from None
    if not rows:
        raise SyncError("sheet_empty")
    return rows, raw


def parse_projects(rows: Sequence[Sequence[str]]) -> list[ProjectRow]:
    if not rows or len(rows[0]) < 3:
        raise SyncError("sheet_format_invalid")
    projects: list[ProjectRow] = []
    for row_number, raw in enumerate(rows[1:], start=2):
        row = list(raw) + [""] * max(0, 33 - len(raw))
        channel = _text(row[2])
        if not channel:
            continue
        number = _text(row[1], 80)
        url = _text(row[0])
        stable = number or _sha256(f"{channel}\0{url}")[:16]
        activities: list[tuple[str, str, int]] = []
        for column in range(7, len(row) - 1, 2):
            activity_date = parse_date(row[column])
            note = _text(row[column + 1])
            if activity_date and note:
                activities.append((activity_date, note, column))
        latest_date = None
        latest_note = ""
        if activities:
            latest_date, latest_note, _ = max(activities, key=lambda item: (item[0], item[2]))
        projects.append(
            ProjectRow(
                project_id=f"sheet:{stable}",
                channel=channel,
                url=url,
                owner=_text(row[4], 100),
                external_owner=_text(row[5], 300),
                contact=_text(row[6], 500),
                latest_date=latest_date,
                latest_note=latest_note,
                activities=tuple(activities),
            )
        )
    return projects


def _schedule_key(channel: str, starts_at: str | None) -> tuple[str, str]:
    return (_text(channel, 300).casefold(), _text(starts_at, 40)[:10])


def _canonical_schedule_id(value: str | None) -> str:
    return "".join(str(value or "").split()).casefold()


def _build_schedule_indexes(
    schedule_pages: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Mapping[str, Any]], dict[tuple[str, str], list[Mapping[str, Any]]]]:
    by_id: dict[str, Mapping[str, Any]] = {}
    by_channel_date: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for page in schedule_pages:
        if not isinstance(page, Mapping):
            continue
        schedule_id = _canonical_schedule_id(notion_value(page, "일정 ID"))
        if schedule_id:
            by_id[schedule_id] = page
            continue
        key = _schedule_key(_text(notion_value(page, "채널명"), 300), _text(notion_value(page, "시작"), 40))
        if key[0] and key[1]:
            by_channel_date.setdefault(key, []).append(page)
    for pages in by_channel_date.values():
        pages.sort(key=lambda page: _page_id(page))
    return by_id, by_channel_date


def _remove_page_from_bucket(bucket: list[Mapping[str, Any]], page_id: str) -> None:
    for index in range(len(bucket) - 1, -1, -1):
        if _page_id(bucket[index]) == page_id:
            bucket.pop(index)


def _remove_schedule_indexes(
    by_id: dict[str, Mapping[str, Any]],
    by_channel_date: dict[tuple[str, str], list[Mapping[str, Any]]],
    page: Mapping[str, Any],
) -> None:
    page_id = _page_id(page)
    if not page_id:
        return
    for schedule_id, indexed_page in list(by_id.items()):
        if _page_id(indexed_page) == page_id:
            del by_id[schedule_id]
    for key, bucket in list(by_channel_date.items()):
        _remove_page_from_bucket(bucket, page_id)
        if not bucket:
            by_channel_date.pop(key, None)


def _pick_unclaimed_schedule(
    candidates: list[Mapping[str, Any]],
    claimed_pages: set[str],
    schedule_id: str,
) -> Mapping[str, Any] | None:
    for page in candidates:
        page_id = _page_id(page)
        if not page_id or page_id in claimed_pages:
            continue
        if _canonical_schedule_id(notion_value(page, "일정 ID")):
            continue
        claimed_pages.add(page_id)
        return page
    return None


def _remember_schedule_match(
    by_id: dict[str, Mapping[str, Any]],
    by_channel_date: dict[tuple[str, str], list[Mapping[str, Any]]],
    claimed_pages: set[str],
    schedule_id: str,
    page: Mapping[str, Any],
    channel: str,
    starts_at: str | None,
    *,
    previous_page: Mapping[str, Any] | None = None,
) -> None:
    if previous_page:
        _remove_schedule_indexes(by_id, by_channel_date, previous_page)
    _remove_schedule_indexes(by_id, by_channel_date, page)
    page_id = _page_id(page)
    schedule_id = _canonical_schedule_id(schedule_id)
    if schedule_id and page_id:
        by_id[schedule_id] = page
    if page_id:
        claimed_pages.add(page_id)
    key = _schedule_key(channel, starts_at)
    if not schedule_id and key[0] and key[1]:
        bucket = by_channel_date.setdefault(key, [])
        if not any(_page_id(item) == page_id for item in bucket):
            bucket.append(page)
            bucket.sort(key=lambda item: _page_id(item))


def project_status(note: str) -> str:
    compact = note.replace(" ", "")
    if any(word in compact for word in ("거절", "종료", "진행안함")):
        return "종료"
    if "보류" in compact:
        return "보류"
    if any(word in compact for word in ("완료", "계약확정")):
        return "완료"
    if "예정" in compact:
        return "예정"
    if any(word in compact for word in ("확정", "진행", "통화", "연락", "발송", "미팅")):
        return "진행"
    return "확인 필요"


def activity_type(note: str) -> str:
    for value in ("방문미팅", "회사방문", "실무미팅", "정기미팅", "미팅", "전화", "이메일", "카톡", "오픈채팅", "제안서"):
        if value in note:
            return value
    return "활동"


def _parse_time(value: str) -> tuple[int, int] | None:
    text = str(value or "").strip()
    match = re.search(r"(?:(오전|오후)\s*)?(\d{1,2})(?::(\d{2})|\s*시)", text)
    if not match:
        return None
    marker, hour_text, minute_text = match.groups()
    hour, minute = int(hour_text), int(minute_text or 0)
    if hour > 23 or minute > 59:
        return None
    if marker == "오후" and hour < 12:
        hour += 12
    elif marker == "오전" and hour == 12:
        hour = 0
    return hour, minute


def parse_calendar(rows: Sequence[Sequence[str]], year: int) -> list[CalendarEvent]:
    """Parse the sheet's compact weekly calendar without guessing missing cells."""
    normalized = [list(row) + [""] * max(0, 8 - len(row)) for row in rows]
    date_rows: list[int] = []
    for index, row in enumerate(normalized):
        numeric_days = sum(bool(re.fullmatch(r"\d{1,2}", str(value).strip())) for value in row[1:8])
        if numeric_days >= 5:
            date_rows.append(index)
    events: list[CalendarEvent] = []
    current_month: int | None = None
    for block_index, row_index in enumerate(date_rows):
        row = normalized[row_index]
        month_match = re.fullmatch(r"(\d{1,2})월", str(row[0]).strip())
        if month_match:
            current_month = int(month_match.group(1))
        if current_month is None:
            continue
        end = date_rows[block_index + 1] if block_index + 1 < len(date_rows) else len(normalized)
        for column in range(1, 8):
            day_text = str(row[column]).strip()
            if not re.fullmatch(r"\d{1,2}", day_text):
                continue
            try:
                event_date = date(year, current_month, int(day_text)).isoformat()
            except ValueError:
                continue
            pending: str | None = None
            event_number = 0
            for content_row in range(row_index + 1, end):
                cell = _text(normalized[content_row][column], 1000)
                if not cell:
                    continue
                parsed_time = _parse_time(cell)
                if parsed_time is not None and pending:
                    hour, minute = parsed_time
                    starts_at = f"{event_date}T{hour:02d}:{minute:02d}:00+09:00"
                    event_number += 1
                    stable = _sha256(f"{event_date}\0{column}\0{pending}\0{starts_at}")[:16]
                    events.append(CalendarEvent(f"calendar:{stable}", starts_at, event_date, pending))
                    pending = None
                elif parsed_time is None:
                    if pending:
                        event_number += 1
                        stable = _sha256(f"{event_date}\0{column}\0{pending}\0{event_number}")[:16]
                        events.append(CalendarEvent(f"calendar:{stable}", event_date, event_date, pending))
                    pending = cell
            if pending:
                event_number += 1
                stable = _sha256(f"{event_date}\0{column}\0{pending}\0{event_number}")[:16]
                events.append(CalendarEvent(f"calendar:{stable}", event_date, event_date, pending))
    return events


def _same_or_newer(candidate: str | None, existing: str | None) -> bool:
    if not candidate:
        return not existing
    return not existing or candidate[:10] >= existing[:10]


def project_properties(row: ProjectRow, existing: Mapping[str, Any] | None, source_url: str) -> dict[str, Any]:
    current_date = notion_value(existing or {}, "최근 활동일")
    use_sheet_state = _same_or_newer(row.latest_date, current_date)
    properties: dict[str, Any] = {
        "채널명": title(row.channel),
        "프로젝트 ID": rich(row.project_id),
        "채널 URL": {"url": row.url or None},
        "담당자": select(row.owner or "미지정"),
        "외부 담당자": rich(row.external_owner),
        "연락처": {"phone_number": row.contact or None},
        "출처": select("Google Sheets"),
        "관리시트": {"url": source_url},
        "마지막 동기화": date_value(_now()),
    }
    if use_sheet_state and row.latest_date:
        status = project_status(row.latest_note)
        properties.update(
            {
                "최근 활동일": date_value(row.latest_date),
                "최근 내용": rich(row.latest_note),
                "진행단계": select(status),
                "상태 상세": rich(row.latest_note),
                "다음 행동": rich(row.latest_note),
                "확인 필요": {"checkbox": status == "확인 필요"},
            }
        )
    return properties


def schedule_properties(
    row: ProjectRow,
    activity: tuple[str, str, int],
    project_page_id: str,
    source_url: str,
    conflict: bool,
) -> dict[str, Any]:
    activity_date, note, column = activity
    schedule_id = _canonical_schedule_id(f"{row.project_id}:{activity_date}:{column}")
    status = project_status(note)
    return {
        "일정명": title(f"{activity_date} · {row.channel} · {_text(note, 500)}"),
        "일정 ID": rich(schedule_id),
        "시작": date_value(activity_date),
        "유형": rich(activity_type(note)),
        "채널명": rich(row.channel),
        "프로젝트 ID": rich(row.project_id),
        "프로젝트": {"relation": [{"id": project_page_id}]},
        "담당자": select(row.owner or "미지정"),
        "상태": select(status),
        "결과": rich(note if status in {"완료", "종료"} else ""),
        "다음 행동": rich(note),
        "메모": rich(note),
        "일정 충돌": {"checkbox": conflict},
        "관리시트": {"url": source_url},
        "마지막 동기화": date_value(_now()),
    }


def calendar_properties(
    event: CalendarEvent,
    project: ProjectRow | None,
    project_page_id: str | None,
    source_url: str,
    conflict: bool,
) -> dict[str, Any]:
    future = event.event_date >= _today()
    properties: dict[str, Any] = {
        "일정명": title(f"{event.event_date} · {_text(event.name, 600)}"),
        "일정 ID": rich(_canonical_schedule_id(event.event_id)),
        "시작": date_value(event.starts_at),
        "유형": rich(activity_type(event.name)),
        "채널명": rich(project.channel if project else event.name),
        "프로젝트 ID": rich(project.project_id if project else ""),
        "담당자": select(project.owner if project and project.owner else "미지정"),
        "상태": select("예정" if future else "확인 필요"),
        "다음 행동": rich(event.name),
        "메모": rich(event.name),
        "일정 충돌": {"checkbox": conflict},
        "관리시트": {"url": source_url},
        "마지막 동기화": date_value(_now()),
    }
    if project_page_id:
        properties["프로젝트"] = {"relation": [{"id": project_page_id}]}
    return properties


def _page_id(page: Mapping[str, Any]) -> str:
    return _text(page.get("id"), 100)


def sync_sheet(settings: Mapping[str, Any], client: NotionClient, state: dict[str, Any]) -> dict[str, int]:
    spreadsheet_id = _text(settings["spreadsheet_id"])
    tab = _text(settings.get("collaboration_sheet") or "협업리스트")
    url = sheet_csv_url(spreadsheet_id, tab)
    rows, raw = fetch_csv(url)
    schedule_tab = _text(settings.get("schedule_sheet") or "미팅스케쥴")
    schedule_rows, schedule_raw = fetch_csv(sheet_csv_url(spreadsheet_id, schedule_tab))
    combined_hash = _sha256(SYNC_SCHEMA_VERSION.encode("ascii") + b"\0" + raw + b"\0" + schedule_raw)
    if state.get("last_sheet_sha256") == combined_hash:
        state["last_sheet_success_at"] = _now()
        return {"projects": 0, "schedules": 0}
    projects = parse_projects(rows)
    source_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit"
    calendar_events = parse_calendar(schedule_rows, int(settings.get("schedule_year") or date.today().year))
    project_by_name = sorted(projects, key=lambda item: len(item.channel), reverse=True)
    calendar_context: list[tuple[CalendarEvent, ProjectRow | None]] = []
    for event in calendar_events:
        folded_name = event.name.casefold()
        matched_project = next(
            (project for project in project_by_name if len(project.channel) >= 3 and project.channel.casefold() in folded_name),
            None,
        )
        calendar_context.append((event, matched_project))

    project_pages = client.pages(_text(settings["projects_data_source_id"]))
    by_id = {_text(notion_value(page, "프로젝트 ID"), 200): page for page in project_pages}
    by_channel = {_text(notion_value(page, "채널명"), 300).casefold(): page for page in project_pages}
    project_page_ids: dict[str, str] = {}
    changed_projects = 0
    for row in projects:
        existing = by_id.get(row.project_id) or by_channel.get(row.channel.casefold())
        properties = project_properties(row, existing, source_url)
        page = client.update(_page_id(existing), properties) if existing else client.create(_text(settings["projects_data_source_id"]), properties)
        project_page_ids[row.project_id] = _page_id(page)
        changed_projects += 1

    schedule_pages = client.pages(_text(settings["schedule_data_source_id"]))
    schedule_by_id, schedule_by_channel_date = _build_schedule_indexes(schedule_pages)
    incoming_schedule_ids = {
        _canonical_schedule_id(f"{row.project_id}:{activity_date}:{column}")
        for row in projects
        for activity_date, _note, column in row.activities
    }
    incoming_schedule_ids.update(_canonical_schedule_id(event.event_id) for event, _project in calendar_context)
    incoming_schedule_ids.discard("")
    claimed_schedule_page_ids: set[str] = set()
    for schedule_id in incoming_schedule_ids:
        existing = schedule_by_id.get(schedule_id)
        if existing:
            existing_id = _page_id(existing)
            if existing_id:
                claimed_schedule_page_ids.add(existing_id)

    collision_counts: dict[tuple[str, str], int] = {}
    for row in projects:
        for activity_date, _note, _column in row.activities:
            collision_counts[(row.owner, activity_date)] = collision_counts.get((row.owner, activity_date), 0) + 1

    changed_schedules = 0
    for row in projects:
        project_page_id = project_page_ids.get(row.project_id)
        if not project_page_id:
            continue
        for activity in row.activities:
            activity_date, _note, column = activity
            schedule_id = _canonical_schedule_id(f"{row.project_id}:{activity_date}:{column}")
            existing = schedule_by_id.get(schedule_id)
            if existing is None:
                candidates = schedule_by_channel_date.get(_schedule_key(row.channel, activity_date), [])
                existing = _pick_unclaimed_schedule(
                    candidates,
                    claimed_schedule_page_ids,
                    schedule_id,
                )
            props = schedule_properties(
                row,
                activity,
                project_page_id,
                source_url,
                collision_counts.get((row.owner, activity_date), 0) > 1,
            )
            if existing:
                target_page = client.update(_page_id(existing), props)
                before_page = existing
            else:
                target_page = client.create(_text(settings["schedule_data_source_id"]), props)
                before_page = None
            target_page = target_page or existing
            if target_page:
                _remember_schedule_match(
                    schedule_by_id,
                    schedule_by_channel_date,
                    claimed_schedule_page_ids,
                    schedule_id,
                    target_page,
                    row.channel,
                    activity_date,
                    previous_page=before_page,
                )
            changed_schedules += 1

    calendar_conflicts: dict[tuple[str, str], int] = {}
    for event, project in calendar_context:
        key = ((project.owner if project else "미지정"), event.starts_at)
        calendar_conflicts[key] = calendar_conflicts.get(key, 0) + 1
    for event, project in calendar_context:
        event_id = _canonical_schedule_id(event.event_id)
        existing = schedule_by_id.get(event_id)
        before_page = existing
        channel = project.channel if project else event.name
        target_page = existing
        if existing is None:
            candidates = schedule_by_channel_date.get(_schedule_key(channel, event.event_date), [])
            existing = _pick_unclaimed_schedule(candidates, claimed_schedule_page_ids, event_id)
            before_page = None
        project_page_id = project_page_ids.get(project.project_id) if project else None
        props = calendar_properties(
            event,
            project,
            project_page_id,
            source_url,
            calendar_conflicts.get(((project.owner if project else "미지정"), event.starts_at), 0) > 1,
        )
        if existing:
            target_page = client.update(_page_id(existing), props)
            before_page = existing
        else:
            target_page = client.create(_text(settings["schedule_data_source_id"]), props)
            before_page = None
        if target_page:
            _remember_schedule_match(
                schedule_by_id,
                schedule_by_channel_date,
                claimed_schedule_page_ids,
                event_id,
                target_page,
                channel,
                event.event_date,
                previous_page=before_page,
            )
        changed_schedules += 1

    state["last_sheet_sha256"] = combined_hash
    state["last_sheet_success_at"] = _now()
    return {"projects": changed_projects, "schedules": changed_schedules}


def _report_text(paths: Sequence[Path]) -> str:
    parts: list[str] = []
    total = 0
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        remaining = 250_000 - total
        if remaining <= 0:
            break
        parts.append(text[:remaining])
        total += min(len(text), remaining)
    return "\n".join(parts)


def _next_action(text: str) -> str:
    for line in text.splitlines():
        cleaned = re.sub(r"^[\s>*#\-+\d.)\[\]xX]+", "", line).strip()
        if len(cleaned) < 8:
            continue
        if any(word in cleaned for word in ("다음 행동", "후속", "확인해야", "확인 필요", "해야 함", "실행")):
            return _text(cleaned, 700)
    return ""


def _plaud_payload_hash(source_id: str, summary: str, paths: Sequence[Path]) -> str:
    digest = hashlib.sha256()
    digest.update(source_id.encode("utf-8"))
    digest.update(b"\0")
    digest.update(summary.encode("utf-8"))
    for path in paths:
        digest.update(b"\0")
        digest.update(path.name.encode("utf-8"))
        try:
            digest.update(path.read_bytes())
        except OSError:
            pass
    return digest.hexdigest()


def sync_plaud_delivery(
    private_root: Path,
    *,
    source_id: str,
    summary: str,
    report_paths: Sequence[Path] = (),
    title_text: str = "",
    recorded_at: str | None = None,
    settings_path: Path | None = None,
    client: NotionClient | None = None,
) -> dict[str, Any]:
    settings_file = settings_path or private_root / "volcano-sync-settings.json"
    settings = load_settings(settings_file)
    state_path = private_root / "volcano-sync-state.json"
    state = load_json(state_path, {"version": 1, "plaud": {}})
    plaud_state = state.setdefault("plaud", {})
    if not isinstance(plaud_state, dict):
        plaud_state = {}
        state["plaud"] = plaud_state
    paths = tuple(Path(path) for path in report_paths)
    payload_hash = _plaud_payload_hash(source_id, summary, paths)
    if plaud_state.get(source_id) == payload_hash:
        return {"status": "unchanged", "matched": 0}

    notion = client or NotionClient()
    pages = notion.pages(_text(settings["projects_data_source_id"]))
    corpus = "\n".join((title_text, summary, _report_text(paths)))
    folded = corpus.casefold()
    matched: list[dict[str, Any]] = []
    for page in pages:
        channel = _text(notion_value(page, "채널명"), 300)
        if len(channel) >= 3 and channel.casefold() in folded:
            matched.append(page)

    event_date = parse_date(recorded_at or "") or _today()
    action = _next_action(corpus)
    brief = _text(summary or _report_text(paths), MAX_TEXT)
    for page in matched:
        existing_date = _text(notion_value(page, "최근 활동일"), 40) or None
        properties: dict[str, Any] = {
            "PLAUD 보강 내용": rich(brief),
            "PLAUD 반영일": date_value(event_date),
            "PLAUD 근거": {"url": f"https://app.plaud.ai/?recording_id={urllib.parse.quote(source_id)}"},
            "마지막 동기화": date_value(_now()),
        }
        if _same_or_newer(event_date, existing_date):
            properties["최근 활동일"] = date_value(event_date)
            properties["최근 내용"] = rich(brief)
            if action:
                properties["다음 행동"] = rich(action)
        notion.update(_page_id(page), properties)

    if not matched:
        operation_id = f"plaud:{source_id}:project-match"
        operation_pages = notion.pages(_text(settings["operations_data_source_id"]))
        existing = next(
            (
                page
                for page in operation_pages
                if _text(notion_value(page, "근거 회의"), 500).endswith(
                    "recording_id=" + urllib.parse.quote(source_id)
                )
            ),
            None,
        )
        properties = {
            "과제명": title(f"PLAUD 프로젝트 연결 확인 · {_text(title_text or source_id, 300)}"),
            "구분": select("채널 협업"),
            "상태": select("확인 필요"),
            "우선순위": select("중간"),
            "다음 행동": rich("해당 녹음을 볼케이노 프로젝트 또는 일정에 연결해 주세요."),
            "근거 회의": {"url": f"https://app.plaud.ai/?recording_id={urllib.parse.quote(source_id)}"},
            "마지막 업데이트": date_value(_now()),
        }
        if existing:
            notion.update(_page_id(existing), properties)
        else:
            notion.create(_text(settings["operations_data_source_id"]), properties)
        state.setdefault("unmatched", {})[operation_id] = event_date

    plaud_state[source_id] = payload_hash
    state["last_plaud_success_at"] = _now()
    atomic_json(state_path, state)
    return {"status": "updated", "matched": len(matched)}


def backfill_plaud(private_root: Path, settings_path: Path | None = None) -> dict[str, int]:
    ledger = load_json(private_root / "telegram-workflow-ledger.json", {})
    jobs = ledger.get("jobs") if isinstance(ledger, Mapping) else None
    if not isinstance(jobs, Mapping):
        return {"processed": 0, "updated": 0}
    processed = updated = 0
    for job in jobs.values():
        if not isinstance(job, Mapping) or job.get("source_kind") != "plaud":
            continue
        # Legacy completed Telegram jobs predate the Notion flag.  Volcano is
        # a separate projection, so a complete analysis is sufficient for a
        # safe one-time backfill.
        if job.get("status") != "complete":
            continue
        source_id = _text(job.get("source_id"), 200)
        summary = _text(job.get("analysis_summary"), 100_000)
        if not source_id or not summary:
            continue
        result = sync_plaud_delivery(
            private_root,
            source_id=source_id,
            summary=summary,
            report_paths=tuple(Path(value) for value in job.get("report_paths", []) if isinstance(value, str)),
            title_text=_text(job.get("title"), 1000),
            recorded_at=_text(job.get("recorded_at"), 100),
            settings_path=settings_path,
        )
        processed += 1
        updated += result.get("status") == "updated"
    return {"processed": processed, "updated": updated}


def notify_if_changed(private_root: Path, counts: Mapping[str, int]) -> None:
    if not any(int(value) for value in counts.values()):
        return
    settings = load_json(private_root / "agent-settings.json", {})
    target = _text(settings.get("telegram_target"), 300)
    binary = _text(settings.get("openclaw_bin"), 500) or "/opt/homebrew/bin/openclaw"
    if not target or not Path(binary).is_file():
        return
    message = (
        "🌋 볼케이노 Notion 동기화 완료\n"
        f"프로젝트 {int(counts.get('projects', 0))} · 일정 {int(counts.get('schedules', 0))} · PLAUD {int(counts.get('plaud', 0))}"
    )
    try:
        subprocess.run(
            [binary, "message", "send", "--channel", "telegram", "--target", target, "--message", message, "--json"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def run_daily(private_root: Path, settings_path: Path | None = None, notify: bool = True) -> dict[str, int]:
    settings_file = settings_path or private_root / "volcano-sync-settings.json"
    settings = load_settings(settings_file)
    state_path = private_root / "volcano-sync-state.json"
    state = load_json(state_path, {"version": 1, "plaud": {}})
    client = NotionClient()
    sheet_counts = sync_sheet(settings, client, state)
    atomic_json(state_path, state)
    plaud_counts = backfill_plaud(private_root, settings_file)
    counts = {**sheet_counts, "plaud": plaud_counts["updated"]}
    if notify:
        notify_if_changed(private_root, counts)
    return counts


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync Volcano Google Sheet and PLAUD outcomes to Notion")
    parser.add_argument("--private-root", type=Path, default=DEFAULT_PRIVATE_ROOT)
    parser.add_argument("--settings", type=Path)
    parser.add_argument("--no-notify", action="store_true")
    parser.add_argument("mode", nargs="?", choices=("daily", "plaud-backfill", "check"), default="daily")
    args = parser.parse_args(argv)
    try:
        if args.mode == "daily":
            counts = run_daily(args.private_root, args.settings, notify=not args.no_notify)
        elif args.mode == "plaud-backfill":
            counts = backfill_plaud(args.private_root, args.settings)
        else:
            settings = load_settings(args.settings or args.private_root / "volcano-sync-settings.json")
            rows, _ = fetch_csv(sheet_csv_url(_text(settings["spreadsheet_id"]), _text(settings.get("collaboration_sheet") or "협업리스트")))
            NotionClient().pages(_text(settings["projects_data_source_id"]))
            counts = {"projects": len(parse_projects(rows))}
        print("volcano_notion_sync_ok " + " ".join(f"{key}={value}" for key, value in counts.items()))
        return 0
    except SyncError as error:
        print(f"volcano_notion_sync_failed code={error.code}")
        return 1
    except Exception:
        print("volcano_notion_sync_failed code=unexpected_error")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "NotionClient",
    "ProjectRow",
    "CalendarEvent",
    "SyncError",
    "backfill_plaud",
    "parse_date",
    "parse_projects",
    "parse_calendar",
    "run_daily",
    "sync_plaud_delivery",
]
