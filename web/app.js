// Füzet: the day and week views, the student sheet, the calendar, sign-in and notifications.
import { CONFIG } from './config.js';
import * as f from './format.js';

const { FIRST_HOUR, LAST_HOUR, WEEKDAYS, INITIALS, addDays, monday, parts, cap } = f;

const COLUMNS = 'id, day, hour, name, phone, note';
const CACHE_KEY = 'fuzet.cache.v1';
const VAPID_KEY = 'fuzet.vapid.v1';
const TOAST_MS = 1500;
const ERROR_MS = 3000;
const REVEAL = 84;

const $ = (id) => document.getElementById(id);
const configured = !CONFIG.supabaseUrl.includes('YOUR-PROJECT-REF');
const sb = configured
  ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  : null;

const state = {
  view: 'day',
  day: f.localDay(),
  today: f.localDay(),
  now: f.localMinutes(),
  calMonth: null,
  editing: null,
  userId: null,
};

/** The students the app knows about, by 'day|hour'. */
const data = new Map();
/** Weeks (by their Monday) whose students are known: 'cached' from the last visit, or 'loaded'. */
const weeks = new Map();
const inflight = new Map();
/** Days with students per month, as the server last said, for the calendar's dots. */
const monthDays = new Map();
/** Bumped on every change she makes, so a load that started earlier doesn't undo it. */
let writeVersion = 0;

const key = (day, hour) => `${day}|${hour}`;
const get = (day, hour) => data.get(key(day, hour));
const ready = (mon) => weeks.has(mon);

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function problem(error) {
  const text = `${error?.message ?? ''} ${error?.name ?? ''}`;
  if (!navigator.onLine || /fetch|load failed|network|typeerror/i.test(text)) return 'Nincs internetkapcsolat. Próbáld újra.';
  return 'Valami hiba történt. Próbáld újra.';
}

// ---------------------------------------------------------------------------------------
// Local copy, so the app opens with her students even before the network answers
// ---------------------------------------------------------------------------------------

function saveCache() {
  try {
    const from = addDays(state.today, -62);
    const to = addDays(state.today, 400);
    const rows = [...data.values()].filter((r) => r.day >= from && r.day <= to);
    const known = [...weeks.keys()].filter((m) => m >= monday(from) && m <= to);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ user: state.userId, rows, weeks: known }));
  } catch {
    // Storage full or unavailable: the app still works online.
  }
}

function cachedUserId() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null')?.user ?? null;
  } catch {
    return null;
  }
}

function loadCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (!cache || cache.user !== state.userId) return;
    for (const row of cache.rows) data.set(key(row.day, row.hour), row);
    for (const mon of cache.weeks) if (!weeks.has(mon)) weeks.set(mon, 'cached');
  } catch {
    // A broken cache is ignored; the server has everything.
  }
}

// ---------------------------------------------------------------------------------------
// Loading from Supabase
// ---------------------------------------------------------------------------------------

function loadWeek(mon, force = false) {
  if (inflight.has(mon)) return inflight.get(mon);
  if (!force && weeks.get(mon) === 'loaded') return Promise.resolve();
  const promise = (async () => {
    for (;;) {
      const started = writeVersion;
      const end = addDays(mon, 6);
      const { data: rows, error } = await sb.from('appointments').select(COLUMNS).gte('day', mon).lte('day', end);
      if (error) throw error;
      if (started !== writeVersion) continue;
      for (const k of [...data.keys()]) {
        const day = k.slice(0, 10);
        if (day >= mon && day <= end) data.delete(k);
      }
      for (const row of rows) data.set(key(row.day, row.hour), row);
      weeks.set(mon, 'loaded');
      saveCache();
      return;
    }
  })().finally(() => inflight.delete(mon));
  inflight.set(mon, promise);
  return promise;
}

/** Loads the week on screen (and quietly the ones either side), then redraws. */
async function refreshVisible(force = false) {
  const mon = monday(state.day);
  try {
    await loadWeek(mon, force);
    if (monday(state.day) === mon) render();
  } catch (error) {
    if (monday(state.day) === mon && !ready(mon)) showToast(problem(error), ERROR_MS);
  }
  for (const near of [addDays(mon, 7), addDays(mon, -7)]) {
    loadWeek(near).then(() => { if (monday(state.day) === near) render(); }).catch(() => {});
  }
}

async function loadMonthDays(month) {
  const first = `${month}-01`;
  const last = `${month}-${String(f.daysInMonth(month)).padStart(2, '0')}`;
  const { data: rows, error } = await sb.from('appointments').select('day').gte('day', first).lte('day', last);
  if (error) return;
  monthDays.set(month, new Set(rows.map((r) => r.day)));
  if (state.calMonth === month && !cal.hidden) renderCalendar();
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

const BIN = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 1h4v2H4V4h4l1-1Zm-3 5h12l-.8 11.2A2 2 0 0 1 15.2 21H8.8a2 2 0 0 1-2-1.8L6 8Z"/></svg>';
const PEN = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25Zm17.7-10.2a1 1 0 0 0 0-1.42l-2.33-2.33a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';

const dayView = $('dayView');
const weekView = $('weekView');
const dayList = $('dayList');
const weekGrid = $('weekGrid');

function render(direction = 0) {
  const isDayView = state.view === 'day';
  const mon = monday(state.day);
  $('dTitle').textContent = isDayView ? cap(f.monthDay(state.day, state.today)) : f.weekTitle(mon, state.today);
  $('dSub').textContent = isDayView ? f.daySubtitle(state.day, state.today) : f.weekSubtitle(mon, state.today);
  $('prev').setAttribute('aria-label', isDayView ? 'Előző nap' : 'Előző hét');
  $('next').setAttribute('aria-label', isDayView ? 'Következő nap' : 'Következő hét');
  dayView.hidden = !isDayView;
  weekView.hidden = isDayView;
  $('seg').classList.toggle('is-week', !isDayView);
  $('tabDay').setAttribute('aria-selected', String(isDayView));
  $('tabWeek').setAttribute('aria-selected', String(!isDayView));
  if (isDayView) renderDay(); else renderWeek(mon);
  (isDayView ? dayList : weekGrid).classList.toggle('loading', !ready(mon));
  if (direction) {
    const view = isDayView ? dayView : weekView;
    view.classList.remove('in-next', 'in-prev');
    void view.offsetWidth;
    view.classList.add(direction > 0 ? 'in-next' : 'in-prev');
  }
}

function renderDay() {
  openSwipe = null;
  let html = '';
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    const a = get(state.day, h);
    const where = ` data-day="${state.day}" data-hour="${h}"`;
    html += `<div class="row ${f.slotState(state.day, h, state.today, state.now)}"><span class="time">${h}:00</span>`;
    if (!a) {
      html += `<button type="button" class="slot"${where} aria-label="${h}:00, szabad"></button></div>`;
      continue;
    }
    const details = [a.note, a.phone].filter(Boolean).join(' · ');
    html += `<div class="swipe"${where}>` +
      `<button type="button" class="act del" tabindex="-1" aria-label="Törlés"><span class="act-icon">${BIN}</span></button>` +
      `<button type="button" class="act edit" tabindex="-1" aria-label="Módosítás"><span class="act-icon">${PEN}</span></button>` +
      `<div class="slot filled"><span class="name">${esc(a.name)}</span>${details ? `<span class="note">${esc(details)}</span>` : ''}</div>` +
      '</div></div>';
  }
  dayList.innerHTML = html;
}

function renderWeek(mon) {
  let html = '<span></span>';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const cls = d === state.today ? ' today' : '';
    html += `<button type="button" class="wd${cls}" data-open="${d}" aria-label="${esc(`${cap(WEEKDAYS[i])}, ${f.monthDay(d, state.today)}`)}">` +
      `<span class="wd-name">${INITIALS[i]}</span><span class="wd-num">${parts(d).d}</span></button>`;
  }
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    html += `<span class="wtime">${h}</span>`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const a = get(d, h);
      const label = `${cap(WEEKDAYS[i])} ${h}:00, ${a ? a.name : 'szabad'}`;
      html += `<button type="button" class="cell${a ? ' filled' : ''}" data-day="${d}" data-hour="${h}" aria-label="${esc(label)}">` +
        (a ? `<span class="cname">${esc(a.name)}</span>` : '') + '</button>';
    }
  }
  weekGrid.innerHTML = html;
}

const cal = $('cal');

function renderCalendar() {
  const month = state.calMonth;
  $('calTitle').textContent = f.monthTitle(month);
  const first = `${month}-01`;
  const mon = monday(state.day);
  const sun = addDays(mon, 6);
  const fromServer = monthDays.get(month);
  let html = INITIALS.map((t) => `<span class="cal-wd">${t}</span>`).join('');
  html += '<span></span>'.repeat(f.weekday(first));
  for (let n = 1; n <= f.daysInMonth(month); n++) {
    const d = `${month}-${String(n).padStart(2, '0')}`;
    let has = false;
    if (ready(monday(d))) {
      for (let h = FIRST_HOUR; h <= LAST_HOUR && !has; h++) has = data.has(key(d, h));
    } else {
      has = fromServer?.has(d) ?? false;
    }
    let cls = 'cal-day';
    if (d === state.today) cls += ' today';
    if (state.view === 'day' && d === state.day) cls += ' sel';
    if (state.view === 'week' && d >= mon && d <= sun) cls += ' inweek';
    if (has) cls += ' has';
    html += `<button type="button" class="${cls}" data-pick="${d}" aria-label="${esc(f.monthDay(d, state.today))}">${n}</button>`;
  }
  $('calGrid').innerHTML = html;
}

// ---------------------------------------------------------------------------------------
// Overlays: the student sheet and the calendar
// ---------------------------------------------------------------------------------------

const scrim = $('scrim');
const sheet = $('sheet');
const fName = $('fName');
const fPhone = $('fPhone');
const fNote = $('fNote');
let openEl = null;
let saving = false;

function openOverlay(el) {
  openEl = el;
  scrim.hidden = false;
  el.hidden = false;
  void el.offsetWidth;
  scrim.classList.add('open');
  el.classList.add('open');
}

function closeOverlay() {
  const el = openEl;
  if (!el || saving) return;
  openEl = null;
  scrim.classList.remove('open');
  el.classList.remove('open');
  if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur();
  setTimeout(() => {
    if (openEl !== el) el.hidden = true;
    if (!openEl) scrim.hidden = true;
  }, 280);
}

function openSlot(day, hour) {
  const a = get(day, hour);
  state.editing = { day, hour, id: a?.id ?? null };
  $('sheetTitle').textContent = a ? 'Diák módosítása' : 'Új diák';
  $('sheetWhen').textContent = f.slotTitle(day, hour, state.today);
  fName.value = a?.name ?? '';
  fPhone.value = a?.phone ?? '';
  fNote.value = a?.note ?? '';
  updateSave();
  hideToast();
  placeSheet();
  openOverlay(sheet);
  if (!a) fName.focus({ preventScroll: true });
}

function updateSave() {
  $('save').disabled = saving || !fName.value.trim();
}

function setSaving(value) {
  saving = value;
  $('save').textContent = value ? 'Mentés…' : 'Mentés';
  for (const el of [fName, fPhone, fNote, $('cancel')]) el.disabled = value;
  updateSave();
}

sheet.addEventListener('submit', async (event) => {
  event.preventDefault();
  const ed = state.editing;
  const fields = { name: fName.value.trim(), phone: fPhone.value.trim(), note: fNote.value.trim() };
  if (!ed || !fields.name || saving) return;
  setSaving(true);
  writeVersion++;
  const query = ed.id
    ? sb.from('appointments').update(fields).eq('id', ed.id)
    : sb.from('appointments').insert({ day: ed.day, hour: ed.hour, ...fields });
  const { data: row, error } = await query.select(COLUMNS).single();
  setSaving(false);
  if (error) {
    if (error.code === '23505') {
      showToast('Erre az órára már van diák.', ERROR_MS);
      closeOverlay();
      refreshVisible(true);
    } else {
      showToast(problem(error), ERROR_MS);
    }
    return;
  }
  data.set(key(row.day, row.hour), row);
  saveCache();
  closeOverlay();
  render();
  showToast(ed.id ? 'Módosítva' : 'Elmentve');
});

async function deleteStudent(day, hour) {
  const row = get(day, hour);
  if (!row) return;
  writeVersion++;
  data.delete(key(day, hour));
  render();
  showToast(`${row.name} törölve`);
  const { error } = await sb.from('appointments').delete().eq('id', row.id);
  if (error) {
    data.set(key(day, hour), row);
    render();
    showToast(problem(error), ERROR_MS);
    return;
  }
  saveCache();
}

$('cancel').addEventListener('click', closeOverlay);
fName.addEventListener('input', updateSave);
fName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fPhone.focus(); } });
fPhone.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fNote.focus(); } });
scrim.addEventListener('click', closeOverlay);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openSwipe) settle(openSwipe, 0);
  closeOverlay();
});

/** Keeps the sheet above the keyboard. */
function placeSheet() {
  const vv = window.visualViewport;
  const keyboard = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  sheet.style.setProperty('--kb', `${keyboard}px`);
  sheet.classList.toggle('keyboard', keyboard > 80);
}
window.visualViewport?.addEventListener('resize', placeSheet);
window.visualViewport?.addEventListener('scroll', placeSheet);
document.addEventListener('focusout', () => setTimeout(() => {
  if (!document.activeElement || document.activeElement === document.body) window.scrollTo(0, 0);
}, 50));

$('dateBtn').addEventListener('click', () => {
  state.calMonth = state.day.slice(0, 7);
  renderCalendar();
  openOverlay(cal);
  loadMonthDays(state.calMonth);
});
$('calClose').addEventListener('click', closeOverlay);
for (const [id, n] of [['calPrev', -1], ['calNext', 1]]) {
  $(id).addEventListener('click', () => {
    state.calMonth = f.shiftMonth(state.calMonth, n);
    renderCalendar();
    loadMonthDays(state.calMonth);
  });
}
$('calGrid').addEventListener('click', (e) => {
  const button = e.target.closest('[data-pick]');
  if (!button) return;
  const before = state.day;
  state.day = button.getAttribute('data-pick');
  closeOverlay();
  render(Math.sign(state.day.localeCompare(before)));
  refreshVisible();
});

// ---------------------------------------------------------------------------------------
// Messages at the bottom: 1.5 seconds, or swipe one down to put it away
// ---------------------------------------------------------------------------------------

const toast = $('toast');
let toastTimer = null;
let toastDrag = null;

function showToast(text, ms = TOAST_MS) {
  $('toastText').textContent = text;
  toast.style.transition = '';
  toast.style.transform = '';
  toast.hidden = false;
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  toast.classList.remove('show');
  toastTimer = setTimeout(() => {
    toast.hidden = true;
    toast.style.transition = '';
    toast.style.transform = '';
  }, 220);
}

toast.addEventListener('pointerdown', (e) => {
  toastDrag = { id: e.pointerId, y: e.clientY, dy: 0 };
  clearTimeout(toastTimer);
  try { toast.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  toast.style.transition = 'none';
});
toast.addEventListener('pointermove', (e) => {
  if (!toastDrag || e.pointerId !== toastDrag.id) return;
  toastDrag.dy = Math.max(0, e.clientY - toastDrag.y);
  toast.style.transform = `translateY(${toastDrag.dy}px)`;
});
function endToastDrag(e) {
  if (!toastDrag || e.pointerId !== toastDrag.id) return;
  const dy = toastDrag.dy;
  toastDrag = null;
  toast.style.transition = '';
  if (dy > 24) {
    toast.style.transform = `translateY(${dy + 40}px)`;
    hideToast();
  } else {
    toast.style.transform = '';
    toastTimer = setTimeout(hideToast, TOAST_MS);
  }
}
toast.addEventListener('pointerup', endToastDrag);
toast.addEventListener('pointercancel', endToastDrag);

// ---------------------------------------------------------------------------------------
// Navigation and gestures
// ---------------------------------------------------------------------------------------

function step(n) {
  state.day = addDays(state.day, state.view === 'day' ? n : 7 * n);
  render(n);
  refreshVisible();
}

function openDay(day) {
  state.day = day;
  state.view = 'day';
  closeOverlay();
  render();
  refreshVisible();
}

$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('tabDay').addEventListener('click', () => { if (state.view !== 'day') { state.view = 'day'; render(); } });
$('tabWeek').addEventListener('click', () => { if (state.view !== 'week') { state.view = 'week'; render(); } });

// In Hét a sideways swipe moves a week. In Nap it belongs to the students, so only the arrows move the day.
const main = $('main');
let swiped = false;
let sx = 0;
let sy = 0;
main.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
main.addEventListener('touchend', (e) => {
  if (state.view !== 'week') return;
  const dx = e.changedTouches[0].clientX - sx;
  const dy = e.changedTouches[0].clientY - sy;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    swiped = true;
    setTimeout(() => { swiped = false; }, 350);
    step(dx < 0 ? 1 : -1);
  }
}, { passive: true });

// A student slides right to uncover the bin and left to uncover the pen; one at a time.
let openSwipe = null;
let drag = null;
let lastDragEnd = -Infinity;

function moveCard(wrap, x, animate) {
  const card = wrap.querySelector('.slot');
  card.style.transition = animate ? 'transform .22s cubic-bezier(.2, .8, .2, 1)' : 'none';
  card.style.transform = x ? `translateX(${x}px)` : '';
  wrap.dataset.x = x;
}

function settle(wrap, x) {
  moveCard(wrap, x, true);
  if (x) {
    openSwipe = wrap;
    return;
  }
  if (openSwipe === wrap) openSwipe = null;
  setTimeout(() => { if (!Number(wrap.dataset.x)) wrap.classList.remove('active'); }, 240);
}

dayList.addEventListener('pointerdown', (e) => {
  const wrap = e.target.closest('.swipe');
  if (!wrap || e.target.closest('.act')) return;
  drag = { wrap, id: e.pointerId, sx: e.clientX, sy: e.clientY, base: Number(wrap.dataset.x) || 0, moving: false };
});
dayList.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (!drag.moving) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
    if (Math.abs(dx) < 8) return;
    drag.moving = true;
    try { drag.wrap.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (openSwipe && openSwipe !== drag.wrap) settle(openSwipe, 0);
    drag.wrap.classList.add('active');
  }
  let x = drag.base + dx;
  const ax = Math.abs(x);
  if (ax > REVEAL) x = Math.sign(x) * (REVEAL + (ax - REVEAL) * 0.3);
  moveCard(drag.wrap, x, false);
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.moving) return;
  lastDragEnd = e.timeStamp;
  const x = Number(d.wrap.dataset.x) || 0;
  settle(d.wrap, x > REVEAL * 0.57 ? REVEAL : x < -REVEAL * 0.57 ? -REVEAL : 0);
}
dayList.addEventListener('pointerup', endDrag);
dayList.addEventListener('pointercancel', endDrag);

main.addEventListener('click', (e) => {
  // The click a finished drag produces is not a tap.
  if (swiped || e.timeStamp - lastDragEnd < 300) return;
  const act = e.target.closest('.act');
  if (act) {
    const wrap = act.closest('.swipe');
    const day = wrap.getAttribute('data-day');
    const hour = Number(wrap.getAttribute('data-hour'));
    if (act.classList.contains('del')) {
      deleteStudent(day, hour);
    } else {
      settle(wrap, 0);
      openSlot(day, hour);
    }
    return;
  }
  if (openSwipe) {
    settle(openSwipe, 0);
    return;
  }
  if (e.target.closest('.swipe')) return;
  const open = e.target.closest('[data-open]');
  if (open) {
    openDay(open.getAttribute('data-open'));
    return;
  }
  const slot = e.target.closest('[data-hour]');
  if (slot) openSlot(slot.getAttribute('data-day'), Number(slot.getAttribute('data-hour')));
});

// ---------------------------------------------------------------------------------------
// The clock: the hour under way is marked, and a new day moves "today" along
// ---------------------------------------------------------------------------------------

function tick() {
  const today = f.localDay();
  const now = f.localMinutes();
  if (today !== state.today) {
    if (state.day === state.today) state.day = today;
    state.today = today;
    state.now = now;
    render();
    refreshVisible();
    return;
  }
  const newHour = Math.floor(now / 60) !== Math.floor(state.now / 60);
  state.now = now;
  if (newHour && !drag && !openSwipe) render();
}

setInterval(() => { if (state.userId) tick(); }, 20000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.userId) return;
  tick();
  refreshVisible(true);
  refreshNotice();
});

// ---------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let vapidKeyPromise = null;
let subscribedThisVisit = false;

function pushSupport() {
  if (isIOS && !standalone()) return 'install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function sameBytes(buffer, bytes) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((b, i) => b === bytes[i]);
}

/** The server's VAPID public key; asking for it also lets the server finish its setup. */
function vapidKey() {
  vapidKeyPromise ??= (async () => {
    try {
      const response = await fetch(`${CONFIG.supabaseUrl}/functions/v1/notify`);
      if (!response.ok) throw new Error(`notify answered ${response.status}`);
      const { publicKey } = await response.json();
      try { localStorage.setItem(VAPID_KEY, publicKey); } catch { /* storage unavailable */ }
      return publicKey;
    } catch (error) {
      let cached = null;
      try { cached = localStorage.getItem(VAPID_KEY); } catch { /* storage unavailable */ }
      if (cached) return cached;
      vapidKeyPromise = null;
      throw error;
    }
  })();
  return vapidKeyPromise;
}

async function ensureSubscribed() {
  const registration = await navigator.serviceWorker.ready;
  const applicationServerKey = fromBase64Url(await vapidKey());
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameBytes(subscription.options?.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  const json = subscription.toJSON();
  const { error } = await sb.from('push_subscriptions')
    .upsert({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }, { onConflict: 'endpoint' });
  if (error) throw error;
  subscribedThisVisit = true;
}

const NOTICES = {
  install: 'Az értesítésekhez koppints a Megosztás gombra, add hozzá a Füzetet a Főképernyőhöz, és onnan nyisd meg.',
  default: 'Kapcsold be az értesítéseket: a Füzet szól 1 órával minden diák előtt, és este 9-kor a holnapi diákjaidról.',
  denied: 'Az értesítések ki vannak kapcsolva. A Beállítások › Értesítések › Füzet menüben kapcsolhatod be őket.',
  failed: 'Az értesítéseket most nem sikerült beállítani.',
};

function showNotice(kind, button = null) {
  $('notice').hidden = !kind;
  if (!kind) return;
  $('noticeText').textContent = NOTICES[kind];
  $('noticeBtn').hidden = !button;
  if (button) $('noticeBtn').textContent = button;
}

async function refreshNotice() {
  const support = pushSupport();
  if (support === 'unsupported') return showNotice(null);
  if (support === 'install') return showNotice('install');
  if (support === 'denied') return showNotice('denied');
  if (support === 'default') {
    vapidKey().catch(() => {});
    return showNotice('default', 'Bekapcsolás');
  }
  if (subscribedThisVisit) return showNotice(null);
  try {
    await ensureSubscribed();
    showNotice(null);
  } catch (error) {
    console.warn('push subscription failed', error);
    showNotice('failed', 'Újra');
  }
}

$('noticeBtn').addEventListener('click', async () => {
  const button = $('noticeBtn');
  button.disabled = true;
  try {
    // Asked straight from the tap: iOS only shows the question for a tap.
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission === 'granted') {
      await ensureSubscribed();
      showToast('Értesítések bekapcsolva');
    }
  } catch (error) {
    console.warn('turning on notifications failed', error);
    showToast(problem(error), ERROR_MS);
  } finally {
    button.disabled = false;
    refreshNotice();
  }
});

// ---------------------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------------------

function showLogin(message = '') {
  state.userId = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('installTip').hidden = !(isIOS && !standalone());
  $('loginError').hidden = !message;
  $('loginError').textContent = message;
}

function enterApp(user) {
  if (state.userId === user.id) return;
  if (state.userId) {
    data.clear();
    weeks.clear();
    monthDays.clear();
  }
  state.userId = user.id;
  $('login').hidden = true;
  $('app').hidden = false;
  loadCache();
  render();
  refreshVisible();
  refreshNotice();
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  const button = $('loginBtn');
  if (!email || !password) {
    showLogin('Add meg az e-mail-címed és a jelszavad.');
    return;
  }
  button.disabled = true;
  button.textContent = 'Belépés…';
  const { data: signedIn, error } = await sb.auth.signInWithPassword({ email, password });
  button.disabled = false;
  button.textContent = 'Belépés';
  if (error) {
    showLogin(error.status === 400 || /invalid/i.test(error.message) ? 'Hibás e-mail-cím vagy jelszó.' : problem(error));
    return;
  }
  $('password').value = '';
  enterApp(signedIn.user);
});

// ---------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((error) => console.warn('service worker', error));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-day' && f.isDay(e.data.day) && state.userId) openDay(e.data.day);
  });
}

const requested = new URLSearchParams(window.location.search).get('nap');
if (f.isDay(requested)) state.day = requested;
if (requested !== null) history.replaceState(null, '', window.location.pathname);

if (!configured) {
  showLogin('A Supabase-projekt címe még nincs beállítva (web/config.js).');
} else {
  const { data: { session }, error } = await sb.auth.getSession();
  if (session) enterApp(session.user);
  // Offline with an expired token: Supabase keeps the session and renews it once online.
  else if (error && problem(error).startsWith('Nincs internet') && cachedUserId()) enterApp({ id: cachedUserId() });
  else showLogin();
  sb.auth.onAuthStateChange((event, changed) => {
    // Supabase asks not to call it again from inside this callback, hence the timeout.
    setTimeout(() => {
      if (event === 'SIGNED_OUT') showLogin();
      else if (changed?.user && event === 'SIGNED_IN') enterApp(changed.user);
    }, 0);
  });
}
