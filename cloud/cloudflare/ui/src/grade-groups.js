const normalized = (value) =>
  String(value || "")
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("tr");

export function examLabel(record) {
  const fields = record.fields || {};
  const explicit =
    fields["Sınav Adı"] ||
    fields["Sınav Türü"] ||
    fields["Sınav Tipi"] ||
    fields["Sınav"] ||
    fields["Değerlendirme Türü"] ||
    fields["Sütun 1"];
  const title = String(record.title || "").startsWith(`${record.course} — `)
    ? record.title.slice(record.course.length + 3)
    : record.title;
  const label = normalized(explicit || title).replace(/[:\s]+$/, "");
  if (/\bmazeret\b/.test(label)) return "Mazeret";
  if (
    /(?:^|[^a-zçğıöşü])(?:vize|ara\s*sınav[ıi]?|midterm)(?:$|[^a-zçğıöşü])/.test(
      label,
    )
  )
    return "Vize";
  if (
    /(?:^|[^a-zçğıöşü])(?:final|yarıyıl\s*sonu|yıl\s*sonu)(?:$|[^a-zçğıöşü])/.test(
      label,
    )
  )
    return "Final";
  return null;
}

const examOrder = label => ({ Vize: 0, Mazeret: 1, Final: 2 })[label] ?? 3;

export function gradeValue(record) {
  const fields = record.fields || {};
  for (const key of [
    "Not",
    "Notu",
    "Alınan Not",
    "Puan",
    "Sınav Notu",
    "Sütun 2",
  ]) {
    if (Object.hasOwn(fields, key))
      return String(fields[key] ?? "").trim() || "—";
  }
  return record.status === "pending" ? "—" : "Ayrıntıyı gör";
}

/** Keep course/platform boundaries and every original record; this is display grouping only. */
export function groupGrades(records) {
  const rows = [],
    courses = new Map();
  for (const record of records) {
    const label = examLabel(record);
    if (!label || !record.course?.trim()) {
      rows.push({ id: record.id, type: "single", record });
      continue;
    }
    const key = JSON.stringify([record.platform, normalized(record.course)]);
    let row = courses.get(key);
    if (!row) {
      row = {
        id: `course/${key}`,
        type: "exams",
        course: record.course,
        platform: record.platform,
        records: [],
      };
      courses.set(key, row);
      rows.push(row);
    }
    row.records.push({ label, value: gradeValue(record), record });
  }
  for (const row of courses.values())
    row.records.sort(
      (a, b) => examOrder(a.label) - examOrder(b.label),
    );
  return rows;
}

/** Ders başına kart görünümü: her kayıt korunur, yalnızca görüntüleme amaçlı gruplanır. */
export function groupByCourse(records) {
  const courses = new Map();
  for (const record of records) {
    const course = String(record.course || "").trim() || "Ders bilgisi olmayan kayıtlar";
    const key = JSON.stringify([record.platform, normalized(course)]);
    if (!courses.has(key)) courses.set(key, { id: key, course, platform: record.platform, entries: [] });
    const label = examLabel(record);
    const title = String(record.title || "").startsWith(`${record.course} — `)
      ? record.title.slice(record.course.length + 3)
      : record.title;
    const value = gradeValue(record);
    courses.get(key).entries.push({
      id: record.id,
      label: label || String(title || "Kayıt").replace(/[:\s]+$/, ""),
      value: value === "Ayrıntıyı gör" ? null : value,
      status: record.status,
      record,
    });
  }
  return [...courses.values()]
    .map((c) => ({ ...c, entries: c.entries.sort((a, b) => examOrder(a.label) - examOrder(b.label)) }))
    .sort((a, b) => a.course.localeCompare(b.course, "tr"));
}
