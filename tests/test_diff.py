"""Değişiklik algılama: baseline, yeni, güncelleme, kaldırma, tekilleştirme."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from unitakip.diff import apply_snapshot
from unitakip.models import Item, Kind, Snapshot
from unitakip.storage.db import Database

T0 = datetime(2026, 11, 9, 10, 0, tzinfo=UTC)


def item(eid: str, scope: str = "course:1:contents", **kw) -> Item:
    base = {"platform": "p", "external_id": eid, "kind": Kind.FILE, "title": eid, "scope": scope,
            "course_name": "Fizik", "data": {"filesize": 10}}
    base.update(kw)
    return Item(**base)


def snap(items, complete=("course:1:contents",), partial=()) -> Snapshot:
    s = Snapshot(platform="p", items=list(items))
    for c in complete:
        s.ok(c)
    for c in partial:
        s.ok(c, removable=False)
    return s


def test_first_run_is_silent_baseline():
    db = Database(":memory:")
    changes = apply_snapshot(db, snap([item("a"), item("b")]), T0)
    assert len(changes) == 2 and all(c.silent for c in changes)
    assert db.pending_changes() == []
    assert db.get_state("p").baseline_done


def test_new_updated_unchanged_and_summary():
    db = Database(":memory:")
    apply_snapshot(db, snap([item("a", data={"filesize": 10, "duedate": 1700000000})]), T0)
    changes = apply_snapshot(db, snap([
        item("a", data={"filesize": 20, "duedate": 1700086400}),
        item("b"),
    ]), T0 + timedelta(hours=1))
    kinds = {c.item.external_id: c.change_type for c in changes}
    assert kinds == {"a": "updated", "b": "new"}
    upd = next(c for c in changes if c.change_type == "updated")
    assert "Dosya boyutu: 10 → 20" in upd.summary and "Teslim tarihi" in upd.summary
    assert len(db.pending_changes()) == 2
    # aynı içerik tekrar gelirse değişiklik yok
    assert apply_snapshot(db, snap([item("a", data={"filesize": 20, "duedate": 1700086400}), item("b")]),
                          T0 + timedelta(hours=2)) == []


def test_removal_only_in_complete_known_scopes():
    db = Database(":memory:")
    apply_snapshot(db, snap([item("a"), item("x", scope="forum:1")], partial=("forum:1",)), T0)
    # kapsam bu kez başarısız (complete değil) → kaldırma yok
    s = Snapshot(platform="p")
    s.fail("course:1:contents", "ağ hatası")
    assert apply_snapshot(db, s, T0 + timedelta(hours=1)) == []
    # kısmi kapsamda görünmeyen öğe kaldırılmaz
    changes = apply_snapshot(db, snap([], complete=("course:1:contents",), partial=("forum:1",)), T0 + timedelta(hours=2))
    assert [(c.item.external_id, c.change_type) for c in changes] == [("a", "removed")]
    assert changes[0].silent  # notify_removed=False varsayılanı
    # yeniden görünürse "updated"
    back = apply_snapshot(db, snap([item("a")]), T0 + timedelta(hours=3))
    assert back[0].change_type == "updated" and not back[0].silent


def test_new_scope_is_silent_but_course_item_is_loud():
    db = Database(":memory:")
    apply_snapshot(db, snap([item("c1", scope="courses", kind=Kind.COURSE)], complete=("courses",)), T0)
    changes = apply_snapshot(db, snap(
        [item("c1", scope="courses", kind=Kind.COURSE), item("c2", scope="courses", kind=Kind.COURSE),
         item("f1", scope="course:2:contents"), item("f2", scope="course:2:contents")],
        complete=("courses", "course:2:contents")), T0 + timedelta(hours=1))
    loud = {c.item.external_id for c in changes if not c.silent}
    assert loud == {"c2"}


def test_empty_scope_then_first_item_is_notified():
    """Notlar kapsamı başta boşsa ilk not 'yeni kapsam' diye sessize alınmamalı."""
    db = Database(":memory:")
    apply_snapshot(db, snap([], complete=("course:1:grades",)), T0)
    changes = apply_snapshot(db, snap([item("g1", scope="course:1:grades", kind=Kind.GRADE)],
                                      complete=("course:1:grades",)), T0 + timedelta(hours=1))
    assert len(changes) == 1 and not changes[0].silent


def test_flip_flop_is_deduplicated():
    db = Database(":memory:")
    apply_snapshot(db, snap([item("a", data={"v": 1})]), T0)
    first = apply_snapshot(db, snap([item("a", data={"v": 2})]), T0 + timedelta(hours=1))
    apply_snapshot(db, snap([item("a", data={"v": 1})]), T0 + timedelta(hours=2))
    again = apply_snapshot(db, snap([item("a", data={"v": 2})]), T0 + timedelta(hours=3))
    assert len(first) == 1 and again == []


def test_duplicate_ids_in_snapshot_ignored():
    db = Database(":memory:")
    changes = apply_snapshot(db, snap([item("a"), item("a")]), T0)
    assert len(changes) == 1
