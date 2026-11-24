const calendar = new Intl.DateTimeFormat("en", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
function calendarDay(value) {
  const parts = Object.fromEntries(
    calendar
      .formatToParts(value)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000;
}
export function daysUntil(value, now = Date.now()) {
  return calendarDay(value) - calendarDay(now);
}
