import { test } from "node:test";
import assert from "node:assert/strict";
import { academicCategory, isExam, gradeStatus } from "../src/academic.js";
import { dashboard } from "../src/panel.js";
import {
  emptyState,
  makeItem,
  mergeSnapshot,
  flushQueue,
  digest,
  parsePage,
  parseUbysCourse,
} from "../src/core.js";

test("exam classification includes quiz and named exam announcements without labelling all events exams", () => {
  for (const title of [
    "ARA SINAV tarihi açıklandı",
    "Vize sınavı",
    "Final programı",
    "Bütünleme Sınavı",
  ])
    assert.equal(isExam({ kind: "announcement", title }), true);
  assert.equal(isExam({ kind: "quiz", title: "Hafta 3" }), true);
  assert.equal(isExam({ kind: "event", title: "Ders toplantısı" }), false);
  assert.equal(
    isExam({ kind: "announcement", title: "Sunum dosyaları" }),
    false,
  );
  assert.equal(academicCategory({ kind: "grade", title: "Vize" }), "grade");
});
test("grade statuses preserve zero scores, placeholders, unknown table fields and course records", () => {
  assert.equal(gradeStatus({ "Sütun 1": "Vize :", "Sütun 2": "Girmedi" }), "pending");
  assert.equal(gradeStatus({ "Sınav Notu": "GR", "İlan Tarihi": "20.11.2026" }), "published");
  assert.equal(gradeStatus({ "Sınav Notu": "-", "Harf Notu Aralığı": "80–90" }), "pending");
  assert.equal(gradeStatus({ Not: "-" }), "pending");
  assert.equal(gradeStatus({ Notu: "Açıklanmadı" }), "pending");
  assert.equal(gradeStatus({ Not: "0" }), "published");
  assert.equal(gradeStatus({ "Alınan Not": "85" }), "published");
  assert.equal(
    gradeStatus({ "Ders Kodu": "BTS321", "Not Sistemi": "Bağıl" }),
    "record",
  );
  assert.equal(gradeStatus({ "Sütun 2": "85" }), "record");
});
test("all platform materials and grade records are projected privately with deduplication and secret URLs cleaned", () => {
  const state = emptyState(),
    config = {
      to: "student@example.com",
      smtp: { password: "SMTPSECRET" },
      platforms: {},
    };
  for (const name of ["sanal", "ogreniyorum", "ubys"]) {
    config.platforms[name] = {
      display_name: name,
      base_url: `https://${name}.example.com`,
      token: "PRIVATE_TOKEN",
    };
    const file = {
      url: `https://${name}.example.com/file.pdf?token=SECRET`,
      name: "Ders Sunumu.pdf",
      size: 1024,
      version: "1",
    };
    const records = [
      makeItem("scope", "grade", "grade", "Vize", {
        course: "Ders",
        fields: { Not: "85", Aralık: "0&ndash;100" },
        url: `https://${name}.example.com/grade`,
      }),
      makeItem("scope", "file", "file", "Ders Sunumu", {
        course: "Ders",
        files: [file],
      }),
    ];
    records.push(
      makeItem("scope", "dup", "assignment", "Ödev", { files: [file] }),
    );
    state.platforms[name] = {
      items: Object.fromEntries(records.map((item) => [item.id, { item }])),
      lastSuccess: 1000,
      cookies: [{ value: "COOKIESECRET" }],
    };
  }
  state.platforms.sanal.items.quiz = {
    item: makeItem("scope", "quiz", "quiz", "Ara sınav"),
  };
  const projected = dashboard(config, state);
  assert.equal(projected.materials.length, 3);
  assert.equal(projected.grades.length, 3);
  assert.equal(projected.exams.length, 1);
  assert.equal(projected.grades[0].fields.Aralık,"0–100");
  assert.ok(
    projected.grades.every(
      (g) => g.fields.Not === "85" && g.status === "published",
    ),
  );
  assert.ok(
    projected.materials.every(
      (m) => m.url.endsWith("file.pdf") && m.course === "Ders",
    ),
  );
  for (const secret of [
    "SMTPSECRET",
    "PRIVATE_TOKEN",
    "COOKIESECRET",
    "token=SECRET",
  ])
    assert.ok(!JSON.stringify(projected).includes(secret));
});
test("published exam grade queues an update and successful mail retains the actual cell difference", async () => {
  const state = emptyState(),
    now = 1900000000000;
  const page = {
    id: "grades",
    kind: "grade",
    content_selector: "#grades",
    track_text: false,
    track_links: false,
    key_columns: [0],
    course_name: "Algoritmalar",
  };
  const html = (value) =>
    `<table id="grades"><tr><th>Sınav Türü</th><th>Not</th></tr><tr><td>Vize</td><td>${value}</td></tr></table>`;
  for (const [i, value] of ["-", "85"].entries())
    mergeSnapshot(
      state,
      "ubys",
      {
        items: parsePage(html(value), "https://ubys.example.com", page),
        complete: ["grades"],
        errors: [],
      },
      now + i,
    );
  assert.equal(Object.values(state.pending)[0].type, "updated");
  let sent;
  await flushQueue(
    state,
    {
      save: async () => {},
      quota: () => 1,
      send: async (name, group) => {
        sent = digest(name, group, String);
      },
    },
    now + 2,
  );
  assert.ok(sent.body.includes("Not: - → 85"));
  assert.equal(state.activity[0].category, "grade");
  assert.equal(state.activity[0].detail, "Not: - → 85");
  assert.equal(Object.keys(state.pending).length, 0);
});

const encodedCourse = (contents) =>
  `<script>var _jsm=null;_jsm=JSON.parse(Base64.decode("${Buffer.from(JSON.stringify({ StudentClassInfo: { CourseName: "Ders", ClassContents: contents } })).toString("base64")}"));</script>`;
test("ÜBYS serialized course files and teacher links are extracted without executing scripts or posting download logs", () => {
  const contents = [
    {
      Id: 1,
      Name: "Ders sunusu",
      PublishedOn: "2026-11-01T12:00:00",
      Files: [
        {
          Id: 4,
          File: {
            Name: "Sunum.pdf",
            EncryptedFileArchiveId: "private-id",
            FileLength: 1024,
            FileExtension: ".pdf",
            ModifiedOn: "2026-11-01",
          },
        },
      ],
      Downloadable: true,
      IsDownloadableStudents: true,
    },
    {
      Id: 2,
      Name: "Ders sunusu 2",
      Explanation: '<a href="https://disk.yandex.com.tr/example">Sunum</a>',
      Files: null,
    },
    {
      Id: 3,
      Name: "Deleted",
      IsDeleted: true,
      Files: [
        {
          Id: 6,
          File: { Name: "deleted.pdf", EncryptedFileArchiveId: "secret" },
        },
      ],
    },
    {
      Id: 4,
      Name: "Future",
      PublishedOn: "2099-01-01T12:00:00",
      Files: [
        {
          Id: 8,
          File: { Name: "future.pdf", EncryptedFileArchiveId: "secret" },
        },
      ],
    },
    {
      Id: 5,
      Name: "Unsafe link",
      Explanation:
        '<a href="javascript:alert(1)">No</a><a href="https://127.0.0.1/private">No</a>',
    },
  ];
  const items = parseUbysCourse(
    encodedCourse(contents),
    "https://ubys.bartin.edu.tr/AIS/Student/Class/ClassDetail?id=private",
    { id: "course" },
    Date.parse("2026-11-09T12:00:00Z"),
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].material.opensSource, true);
  assert.equal(items[0].material.extension, "pdf");
  assert.ok(!JSON.stringify(items).includes("private-id"));
  assert.equal(items[1].material.url, "https://disk.yandex.com.tr/example");
  assert.throws(
    () =>
      parseUbysCourse("<div>Maintenance</div>", "https://ubys.bartin.edu.tr/", {
        id: "course",
      }),
    (e) => e.code === "site",
  );
});
test("ÜBYS same-course PDF files remain separate instead of collapsing into one source-page link", () => {
  const state = emptyState(),
    file = (id) => ({
      Id: id,
      Name: "Week " + id,
      IsDownloadableStudents: true,
      Files: [
        {
          Id: id,
          File: { Name: `Week-${id}.pdf`, EncryptedFileArchiveId: "secret" },
        },
      ],
    });
  const items = parseUbysCourse(
    encodedCourse([file(1), file(2)]),
    "https://ubys.bartin.edu.tr/AIS/Student/Class/ClassDetail?id=private",
    { id: "course" },
  );
  state.platforms.ubys = {
    items: Object.fromEntries(items.map((item) => [item.id, { item }])),
    lastSuccess: 1,
  };
  const config = {
    to: "student@example.com",
    platforms: {
      ubys: { base_url: "https://ubys.bartin.edu.tr/", display_name: "ÜBYS" },
    },
  };
  assert.equal(dashboard(config, state).materials.length, 2);
});
