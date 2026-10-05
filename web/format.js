// Dates and their Hungarian wording. A day is a 'YYYY-MM-DD' string in the phone's own time
// zone; the arithmetic runs in UTC so daylight saving never shifts a day.

export const FIRST_HOUR = 9;
export const LAST_HOUR = 20;

export const MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
const MONTHS_SHORT = ['jan.', 'febr.', 'márc.', 'ápr.', 'máj.', 'jún.', 'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];
export const WEEKDAYS = ['hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat', 'vasárnap'];
export const INITIALS = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];

export function parse(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function iso(date) {
  return date.toISOString().slice(0, 10);
}

export function isDay(text) {
  return typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) && iso(parse(text)) === text;
}

export function addDays(day, n) {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** 0 for hétfő, 6 for vasárnap. */
export function weekday(day) {
  return (parse(day).getUTCDay() + 6) % 7;
}

export function monday(day) {
  return addDays(day, -weekday(day));
}

export function parts(day) {
  const d = parse(day);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

export function cap(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Today on the phone's clock. */
export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Minutes since local midnight. */
export function localMinutes(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}

/** "október 6.", with the year only when it isn't this year: "2027. január 5." */
export function monthDay(day, today) {
  const a = parts(day);
  return (a.y !== parts(today).y ? `${a.y}. ` : '') + `${MONTHS[a.m]} ${a.d}.`;
}

/** "Ma, kedd", "Holnap, szerda", "Tegnap, hétfő", or just "Csütörtök". */
export function daySubtitle(day, today) {
  const relative = day === today ? 'ma' : day === addDays(today, 1) ? 'holnap' : day === addDays(today, -1) ? 'tegnap' : null;
  const name = WEEKDAYS[weekday(day)];
  return cap(relative ? `${relative}, ${name}` : name);
}

/** "Október 5–11.", or across months "Szept. 28. – okt. 4." */
export function weekTitle(mon, today) {
  const a = parts(mon);
  const b = parts(addDays(mon, 6));
  const year = a.y !== parts(today).y ? `${a.y}. ` : '';
  if (a.m === b.m) return cap(`${year}${MONTHS[a.m]} ${a.d}–${b.d}.`);
  return cap(`${year}${MONTHS_SHORT[a.m]} ${a.d}. – ${b.y !== a.y ? `${b.y}. ` : ''}${MONTHS_SHORT[b.m]} ${b.d}.`);
}

export function isoWeek(day) {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + 3 - weekday(day));
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

/** "Ez a hét", "Jövő hét", "Múlt hét", or "42. hét". */
export function weekSubtitle(mon, today) {
  const thisWeek = monday(today);
  if (mon === thisWeek) return 'Ez a hét';
  if (mon === addDays(thisWeek, 7)) return 'Jövő hét';
  if (mon === addDays(thisWeek, -7)) return 'Múlt hét';
  return `${isoWeek(mon)}. hét`;
}

/** "Kedd, október 6. · 11:00–12:00" */
export function slotTitle(day, hour, today) {
  return `${cap(WEEKDAYS[weekday(day)])}, ${monthDay(day, today)} · ${hour}:00–${hour + 1}:00`;
}

/** 'past' once the hour is over, 'now' while it runs, otherwise 'future'. */
export function slotState(day, hour, today, nowMinutes) {
  if (day < today) return 'past';
  if (day > today) return 'future';
  if ((hour + 1) * 60 <= nowMinutes) return 'past';
  if (hour * 60 <= nowMinutes) return 'now';
  return 'future';
}

/** "2026. október" */
export function monthTitle(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y}. ${MONTHS[m - 1]}`;
}

export function shiftMonth(month, n) {
  let [y, m] = month.split('-').map(Number);
  m = m - 1 + n;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
