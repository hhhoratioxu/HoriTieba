// Tieba's list shows Beijing time. A partial label can eliminate an old topic or
// decide which topic to inspect first. It is never evidence for publishing.
export function listCreationWindow(label: string | undefined, observedAt: number) {
  if (!label) return;
  const day = 86400000,
    offset = 8 * 3600000;
  const local = new Date(observedAt + offset);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(label.trim());
  if (clock) {
    const h = Number(clock[1]),
      m = Number(clock[2]);
    if (h > 23 || m > 59) return;
    const start = Math.floor((observedAt + offset) / day) * day - offset + (h * 60 + m) * 60000;
    // Do not guess yesterday for a future-looking clock near midnight or clock skew.
    if (start > observedAt + 2000) return;
    return { start, end: start + 60000 };
  }
  const date = /^(?:(20\d{2})-)?(\d{1,2})-(\d{1,2})$/.exec(label.trim());
  if (!date) return;
  const year = date[1] ? Number(date[1]) : local.getUTCFullYear(),
    month = Number(date[2]),
    d = Number(date[3]);
  const utc = Date.UTC(year, month - 1, d),
    check = new Date(utc);
  if (
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== d ||
    utc - offset > observedAt + 2000
  )
    return;
  return { start: utc - offset, end: utc - offset + day };
}
