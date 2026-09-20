const WEEKDAYS = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];

/** "2026-09-20" → "20.09.2026" */
export function formatDateBg(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
}

/** "2026-09-20" → "неделя" (calendar arithmetic in UTC, so no timezone drift). */
export function weekdayBg(ymd: string): string {
  return WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
}

export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Today's date in Sofia — the day a Bulgarian schedule means by "today". */
export function todayInSofia(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
}

/** "преди 5 ч" — from an ISO string or epoch milliseconds; null when unknown. */
export function timeAgo(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return 'току-що';
  if (min < 60) return `преди ${min} мин`;
  const h = Math.round(min / 60);
  if (h < 24) return `преди ${h} ч`;
  const d = Math.round(h / 24);
  return `преди ${d} ${d === 1 ? 'ден' : 'дни'}`;
}

/** Hours since an ISO string / epoch ms, or null when unknown. */
export function hoursSince(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : (Date.now() - ms) / 3_600_000;
}
