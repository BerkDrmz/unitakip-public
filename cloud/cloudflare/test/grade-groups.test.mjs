import { test } from "node:test";
import assert from "node:assert/strict";
import { groupGrades, gradeValue, examLabel } from "../ui/src/grade-groups.js";

test("midterm and final share one course row, preserve actual values and individual detail targets", () => {
  const records = [
    {
      id: "final",
      platform: "ubys",
      course: "Algoritmalar",
      title: "Algoritmalar — Final :",
      fields: { "Sütun 1": "Final :", "Sütun 2": "Girmedi" },
    },
    {
      id: "vize",
      platform: "ubys",
      course: "Algoritmalar",
      title: "Algoritmalar — Vize :",
      fields: { "Sütun 1": "Vize :", "Sütun 2": "0" },
    },
  ];
  const before = JSON.stringify(records),
    rows = groupGrades(records);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].records.map((r) => [r.label, r.value, r.record.id]),
    [
      ["Vize", "0", "vize"],
      ["Final", "Girmedi", "final"],
    ],
  );
  assert.equal(JSON.stringify(records), before);
});
test("grouping never merges different platforms/courses, drops duplicates or invents an absent final", () => {
  const records = [
    {
      id: "a",
      platform: "ubys",
      course: "Ders",
      title: "Vize",
      fields: { Not: "85" },
    },
    {
      id: "b",
      platform: "sanal",
      course: "Ders",
      title: "Final",
      fields: { Not: "90" },
    },
    {
      id: "c",
      platform: "ubys",
      course: "Başka Ders",
      title: "Final",
      fields: { Not: "-" },
    },
    {
      id: "d",
      platform: "ubys",
      course: "Ders",
      title: "Vize mazeret",
      fields: { Not: "80" },
    },
    {
      id: "other",
      platform: "ubys",
      course: "Ders",
      title: "Ders toplamı",
      fields: { Not: "85" },
    },
  ];
  const rows = groupGrades(records);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].records.length, 2);
  assert.deepEqual(rows[0].records.map(r => r.label), ["Vize", "Mazeret"]);
  assert.equal(rows.at(-1).type, "single");
});
test("localized exam labels and zero/blank scores remain readable", () => {
  assert.equal(examLabel({ title: "Ara Sınav" }), "Vize");
  assert.equal(examLabel({ title: "Yarıyıl sonu sınavı" }), "Final");
  assert.equal(examLabel({ title: "Finalizasyon çalışması" }), null);
  assert.equal(gradeValue({ fields: { Not: 0 } }), "0");
  assert.equal(gradeValue({ fields: { Not: "" } }), "—");
});
