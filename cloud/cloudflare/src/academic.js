const fold = (value) =>
  String(value ?? "")
    .toLocaleLowerCase("tr")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i");
export function isExam(item) {
  return (
    item?.kind === "quiz" ||
    (["event", "announcement", "forum_post"].includes(item?.kind) &&
      /(?:^|[^a-z])(?:sinav|vize|final|butunleme|mazeret|quiz|midterm|exam)(?:[^a-z]|$)/.test(
        fold(item.title),
      ))
  );
}
export function academicCategory(item) {
  return item?.kind === "grade"
    ? "grade"
    : isExam(item)
      ? "exam"
      : ["file", "material"].includes(item?.kind)
        ? "material"
        : "other";
}
export function gradeStatus(fields) {
  if (Object.hasOwn(fields || {}, "Sınav Notu") && /^\d{1,2}[./]\d{1,2}[./]\d{4}\b/.test(fields?.["İlan Tarihi"] || "")) return "published";
  if (fields?.["Ders Kodu"] && fields["Ders Adı"] && Object.hasOwn(fields, "Geçme Notu")) return "record";
  // The two-column ÜBYS overview also says "Girmedi" before an exam is announced.
  if (/^(vize|final|ara sinav|mazeret)\s*:?$/.test(fold(fields?.["Sütun 1"]).trim())) {
    return /^\d+(?:[,.]\d+)?$/.test(String(fields["Sütun 2"] ?? "").trim()) ? "published" : "pending";
  }
  const scores = Object.entries(fields || {}).filter(
    ([label]) =>
      /(?:^|\s)(?:not|notu|puan|puani|score|grade)(?:$|\s)/.test(fold(label)) &&
      !/not sistemi|not turu|notu? araligi|not tipi/.test(fold(label)),
  );
  if (!scores.length) return "record";
  return scores.some(
    ([, value]) =>
      !/^(?:\s*|[-–—]|yok|aciklanmadi|girilmedi|not girilmedi)$/i.test(
        fold(value).trim(),
      ),
  )
    ? "published"
    : "pending";
}
