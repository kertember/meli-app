import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../web/format.js';

const TODAY = '2026-10-06'; // a Tuesday

test('day titles', () => {
  assert.equal(f.cap(f.monthDay('2026-10-06', TODAY)), 'Október 6.');
  assert.equal(f.monthDay('2027-01-05', TODAY), '2027. január 5.');
  assert.equal(f.daySubtitle('2026-10-06', TODAY), 'Ma, kedd');
  assert.equal(f.daySubtitle('2026-10-07', TODAY), 'Holnap, szerda');
  assert.equal(f.daySubtitle('2026-10-05', TODAY), 'Tegnap, hétfő');
  assert.equal(f.daySubtitle('2026-10-08', TODAY), 'Csütörtök');
});

test('week titles', () => {
  assert.equal(f.monday('2026-10-06'), '2026-10-05');
  assert.equal(f.monday('2026-10-11'), '2026-10-05');
  assert.equal(f.weekTitle('2026-10-05', TODAY), 'Október 5–11.');
  assert.equal(f.weekTitle('2026-09-28', TODAY), 'Szept. 28. – okt. 4.');
  assert.equal(f.weekTitle('2026-12-28', TODAY), 'Dec. 28. – 2027. jan. 3.');
  assert.equal(f.weekSubtitle('2026-10-05', TODAY), 'Ez a hét');
  assert.equal(f.weekSubtitle('2026-10-12', TODAY), 'Jövő hét');
  assert.equal(f.weekSubtitle('2026-09-28', TODAY), 'Múlt hét');
  assert.equal(f.weekSubtitle('2026-10-19', TODAY), '43. hét');
  assert.equal(f.isoWeek('2026-12-28'), 53);
  assert.equal(f.isoWeek('2027-01-04'), 1);
});

test('the sheet title names the hour', () => {
  assert.equal(f.slotTitle('2026-10-06', 11, TODAY), 'Kedd, október 6. · 11:00–12:00');
  assert.equal(f.slotTitle('2026-10-07', 20, TODAY), 'Szerda, október 7. · 20:00–21:00');
});

test('an hour is past once it is over', () => {
  const at1040 = 10 * 60 + 40;
  assert.equal(f.slotState('2026-10-05', 20, TODAY, at1040), 'past');
  assert.equal(f.slotState(TODAY, 9, TODAY, at1040), 'past');
  assert.equal(f.slotState(TODAY, 10, TODAY, at1040), 'now');
  assert.equal(f.slotState(TODAY, 11, TODAY, at1040), 'future');
  assert.equal(f.slotState('2026-10-07', 9, TODAY, at1040), 'future');
});

test('days and months', () => {
  assert.equal(f.addDays('2026-10-25', 1), '2026-10-26'); // across the clock change
  assert.equal(f.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(f.localDay(new Date(2026, 9, 6, 23, 59)), '2026-10-06');
  assert.equal(f.localMinutes(new Date(2026, 9, 6, 10, 40)), 640);
  assert.equal(f.monthTitle('2026-10'), '2026. október');
  assert.equal(f.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(f.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(f.daysInMonth('2028-02'), 29);
  assert.ok(f.isDay('2026-10-06'));
  assert.ok(!f.isDay('2026-02-30'));
  assert.ok(!f.isDay('<script>'));
});
