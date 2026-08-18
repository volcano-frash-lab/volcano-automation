from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "volcano_notion_sync.py"
SPEC = importlib.util.spec_from_file_location("volcano_notion_sync", MODULE_PATH)
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync
SPEC.loader.exec_module(sync)


class FakeNotion:
    def __init__(self, projects=None, schedules=None, operations=None, fail_on_create: int = 0):
        self._pages = {
            "projects": [dict(page) for page in (projects or [])],
            "schedules": [dict(page) for page in (schedules or [])],
            "operations": [dict(page) for page in (operations or [])],
        }
        self.created = []
        self.updated = []
        self._next_id = 1
        self._fail_on_create = fail_on_create
        for source in ("projects", "schedules", "operations"):
            for page in self._pages[source]:
                if not page.get("id"):
                    page["id"] = self._next_page_id()

    @property
    def projects(self):
        return self._pages["projects"]

    @property
    def schedules(self):
        return self._pages["schedules"]

    @property
    def operations(self):
        return self._pages["operations"]

    def _with_properties(self, properties):
        if properties is None or isinstance(properties, (str, int, float, bool)):
            return properties
        result = {}
        for key, value in (properties or {}).items():
            if isinstance(value, dict):
                result[key] = {key2: self._with_properties(value2) for key2, value2 in value.items()}
            elif isinstance(value, list):
                result[key] = [self._with_properties(value2) for value2 in value]
            else:
                result[key] = value
        return result

    def _copy_properties(self, properties):
        return {k: self._with_properties(v) for k, v in properties.items()}

    def _find(self, data_source_id, page_id):
        return next((page for page in self._pages[data_source_id] if page.get("id") == page_id), None)

    def _resolve_source(self, data_source_id):
        if data_source_id in self._pages:
            return data_source_id
        return {
            "projects_data_source_id": "projects",
            "schedule_data_source_id": "schedules",
            "operations_data_source_id": "operations",
        }.get(data_source_id, data_source_id)

    def _next_page_id(self):
        value = "new-" + str(self._next_id)
        self._next_id += 1
        return value

    def pages(self, data_source_id):
        source = self._resolve_source(data_source_id)
        return list(self._pages[source])

    def create(self, data_source_id, properties):
        if self._fail_on_create:
            self._fail_on_create -= 1
            raise sync.SyncError("notion_request_failed")
        source = self._resolve_source(data_source_id)
        page = {"id": self._next_page_id(), "properties": self._copy_properties(properties)}
        self._pages[source].append(page)
        self.created.append((source, properties))
        return page

    def update(self, page_id, properties):
        page_id = str(page_id)
        target = None
        for source, pages in self._pages.items():
            target = self._find(source, page_id)
            if target is not None:
                break
        if not target:
            return {"id": page_id, "properties": self._copy_properties(properties)}
        target_properties = target.get("properties") if isinstance(target.get("properties"), dict) else {}
        target_properties.update(self._copy_properties(properties))
        target["properties"] = target_properties
        self.updated.append((page_id, properties))
        return {"id": page_id, "properties": dict(target_properties)}


def rich_property(value):
    return {"type": "rich_text", "rich_text": [{"plain_text": value}]}


def title_property(value):
    return {"type": "title", "title": [{"plain_text": value}]}


def date_property(value):
    return {"type": "date", "date": {"start": value}}


class VolcanoNotionSyncTests(unittest.TestCase):
    def settings(self):
        return {
            "enabled": True,
            "spreadsheet_id": "sheet-id",
            "collaboration_sheet": "협업리스트",
            "schedule_sheet": "미팅스케쥴",
            "projects_data_source_id": "projects",
            "schedule_data_source_id": "schedules",
            "operations_data_source_id": "operations",
        }

    def test_parse_projects_uses_latest_dated_activity(self):
        rows = [
            ["URL", "NO", "채널명"],
            [
                "https://example.test/channel",
                "7",
                "테스트채널",
                "",
                "담당자",
                "외부담당",
                "010-0000-0000",
                "2026.08.01",
                "첫 연락",
                "2026-08-03",
                "후속 미팅 예정",
            ],
        ]
        project = sync.parse_projects(rows)[0]
        self.assertEqual(project.project_id, "sheet:7")
        self.assertEqual(project.latest_date, "2026-08-03")
        self.assertEqual(project.latest_note, "후속 미팅 예정")
        self.assertEqual(sync.project_status(project.latest_note), "예정")

    def test_parse_calendar_pairs_event_with_korean_time(self):
        rows = [
            ["", "일", "월", "화", "수", "목", "금", "토"],
            ["8월", "9", "10", "11", "12", "13", "14", "15"],
            ["", "", "", "테스트채널 방문", "", "", "", ""],
            ["", "", "", "오전 11시", "", "", "", ""],
        ]
        events = sync.parse_calendar(rows, 2026)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].event_date, "2026-08-11")
        self.assertEqual(events[0].starts_at, "2026-08-11T11:00:00+09:00")
        self.assertEqual(events[0].name, "테스트채널 방문")

    def test_sheet_sync_skips_writes_when_both_tabs_are_unchanged(self):
        rows = [["URL", "NO", "채널명"], ["https://example.test", "1", "테스트채널"]]
        raw_a = b"a"
        raw_b = b"b"
        state = {
            "last_sheet_sha256": sync._sha256(
                sync.SYNC_SCHEMA_VERSION.encode("ascii") + b"\0" + raw_a + b"\0" + raw_b
            )
        }
        notion = FakeNotion()
        with mock.patch.object(sync, "fetch_csv", side_effect=[(rows, raw_a), ([[]], raw_b)]):
            result = sync.sync_sheet(self.settings(), notion, state)
        self.assertEqual(result, {"projects": 0, "schedules": 0})
        self.assertEqual(notion.created, [])
        self.assertEqual(notion.updated, [])

    def test_plaud_delivery_updates_matching_project_and_is_idempotent(self):
        project = {
            "id": "project-page",
            "properties": {
                "채널명": title_property("테스트채널"),
                "최근 활동일": {"type": "date", "date": {"start": "2026-08-01"}},
            },
        }
        notion = FakeNotion(projects=[project])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / "volcano-sync-settings.json"
            settings.write_text(json.dumps(self.settings()), encoding="utf-8")
            result = sync.sync_plaud_delivery(
                root,
                source_id="recording-1",
                summary="테스트채널 후속 행동을 확인해야 함",
                title_text="회의",
                recorded_at="2026-08-17",
                settings_path=settings,
                client=notion,
            )
            again = sync.sync_plaud_delivery(
                root,
                source_id="recording-1",
                summary="테스트채널 후속 행동을 확인해야 함",
                title_text="회의",
                recorded_at="2026-08-17",
                settings_path=settings,
                client=notion,
            )
            state_path = root / "volcano-sync-state.json"
            self.assertEqual(oct(state_path.stat().st_mode & 0o777), "0o600")
        self.assertEqual(result, {"status": "updated", "matched": 1})
        self.assertEqual(again, {"status": "unchanged", "matched": 0})
        self.assertEqual(len(notion.updated), 1)
        self.assertIn("PLAUD 보강 내용", notion.updated[0][1])

    def test_unmatched_plaud_creates_review_task_without_content_in_state(self):
        notion = FakeNotion()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / "volcano-sync-settings.json"
            settings.write_text(json.dumps(self.settings()), encoding="utf-8")
            sync.sync_plaud_delivery(
                root,
                source_id="recording-2",
                summary="프로젝트 이름이 없는 합성 요약",
                settings_path=settings,
                client=notion,
            )
            state_text = (root / "volcano-sync-state.json").read_text(encoding="utf-8")
        self.assertEqual(notion.created[0][0], "operations")
        self.assertNotIn("합성 요약", state_text)
        self.assertIn("recording-2", state_text)

    def test_settings_file_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text("{}", encoding="utf-8")
            with self.assertRaises(sync.SyncError) as context:
                sync.load_settings(path)
        self.assertEqual(context.exception.code, "settings_invalid")

    def test_sheet_sync_preserves_canonical_page_and_rekeys_only_legacy_same_day_page(self):
        rows = [
            ["URL", "NO", "채널명", "", "", "", "", "", "", "", "", "", ""],
            [
                "https://example.test/channel",
                "7",
                "테스트채널",
                "",
                "담당자",
                "외부",
                "010-1234-0000",
                "2026-08-20",
                "첫 미팅",
                "2026-08-20",
                "둘째 미팅",
                "",
            ],
        ]
        first_id = "sheet:7:2026-08-20:7"
        second_id = "sheet:7:2026-08-20:9"
        schedules = [
            {
                "id": "legacy-1",
                "properties": {
                    "채널명": rich_property("테스트채널"),
                    "시작": date_property("2026-08-20"),
                },
            },
            {
                "id": "canonical-2",
                "properties": {
                    "일정 ID": rich_property("  SHEET:7:2026-08-20:9  "),
                    "채널명": rich_property("테스트채널"),
                    "시작": date_property("2026-08-20"),
                },
            },
        ]
        state = {}
        notion = FakeNotion(schedules=schedules)
        with mock.patch.object(sync, "fetch_csv", side_effect=[
            (rows, b"project"),
            ([[]], b"calendar"),
            (rows, b"project"),
            ([[]], b"calendar"),
        ]):
            first = sync.sync_sheet(self.settings(), notion, state)
            state.pop("last_sheet_sha256", None)
            second = sync.sync_sheet(self.settings(), notion, state)
        self.assertEqual(first["schedules"], 2)
        self.assertEqual(second["schedules"], 2)
        self.assertEqual(len({sync._page_id(page) for page in notion.schedules}), 2)
        self.assertEqual(len([source for source, _ in notion.created if source == "schedules"]), 0)
        pages_by_id = {sync._page_id(page): page for page in notion.schedules}
        self.assertEqual(sync._canonical_schedule_id(sync.notion_value(pages_by_id["legacy-1"], "일정 ID")), first_id)
        self.assertEqual(sync._canonical_schedule_id(sync.notion_value(pages_by_id["canonical-2"], "일정 ID")), second_id)
        self.assertEqual(
            {
                sync._canonical_schedule_id(sync.notion_value(page, "일정 ID"))
                for page in notion.schedules
            },
            {first_id, second_id},
        )
        schedule_updates = [
            (
                page_id,
                sync._canonical_schedule_id(sync.notion_value({"properties": props}, "일정 ID")),
            )
            for page_id, props in notion.updated
            if "일정 ID" in props
        ]
        self.assertEqual(
            schedule_updates,
            [
                ("legacy-1", first_id),
                ("canonical-2", second_id),
                ("legacy-1", first_id),
                ("canonical-2", second_id),
            ],
        )

    def test_sheet_sync_does_not_mark_hash_on_partial_failure(self):
        rows = [
            ["URL", "NO", "채널명", "", "", "", "", "", "", "", "", "", ""],
            [
                "https://example.test/channel",
                "8",
                "테스트채널",
                "",
                "담당자",
                "외부",
                "010-1234-0000",
                "2026-08-21",
                "미팅 기록",
                "",
                "",
                "",
                "",
            ],
        ]
        notion = FakeNotion(fail_on_create=1)
        state = {}
        with mock.patch.object(sync, "fetch_csv", side_effect=[(rows, b"project"), ([[]], b"calendar")]):
            with self.assertRaises(sync.SyncError):
                sync.sync_sheet(self.settings(), notion, state)
        self.assertNotIn("last_sheet_sha256", state)
        notion._fail_on_create = 0
        with mock.patch.object(sync, "fetch_csv", side_effect=[(rows, b"project"), ([[]], b"calendar")]):
            second = sync.sync_sheet(self.settings(), notion, state)
        self.assertEqual(second["schedules"], 1)
        self.assertEqual(state.get("last_sheet_sha256"), sync._sha256(sync.SYNC_SCHEMA_VERSION.encode("ascii") + b"\0" + b"project" + b"\0" + b"calendar"))


if __name__ == "__main__":
    unittest.main()
