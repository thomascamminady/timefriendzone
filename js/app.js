import * as tz from "./tz.js";

const STORAGE_KEY = "timefriendzone:v2";
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const BROWSER_LOCALE = navigator.language || "en";

const ZONES = (() => {
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  return zones.includes("UTC") ? zones : [...zones, "UTC"];
})();

const $ = (selector) => document.querySelector(selector);

const state = {
  settings: { ...tz.DEFAULT_SETTINGS },
  people: [],
  date: "", // YYYY-MM-DD in the reference (first) person's zone
  selected: null, // instant of the selected column
  source: "saved", // "saved" | "link"
  defaults: { settings: { ...tz.DEFAULT_SETTINGS }, people: [] }, // from config.json
};

// ----------------------------------------------------------------- helpers

const ref = () => state.people[0] ?? { name: "You", tz: LOCAL_TZ };
const locale = () => state.settings.lang || BROWSER_LOCALE;

function useHour12() {
  if (state.settings.hour12 !== null) return state.settings.hour12;
  const cycle = new Intl.DateTimeFormat(locale(), { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12";
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const formatters = new Map();
function format(instant, timeZone, options) {
  const key = JSON.stringify([timeZone, options, useHour12(), locale()]);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale(), { timeZone, hour12: useHour12(), ...options });
    formatters.set(key, formatter);
  }
  return formatter.format(instant);
}

const fmtTime = (t, zone) => format(t, zone, { hour: "numeric", minute: "2-digit" });
const fmtDay = (t, zone) => format(t, zone, { weekday: "short", day: "numeric", month: "short" });
const fmtShortDay = (t, zone) => format(t, zone, { weekday: "short", day: "numeric" });
const fmtLongDate = (t, zone) =>
  format(t, zone, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function hourLabel(parts) {
  const minutes = parts.minute ? `:${String(parts.minute).padStart(2, "0")}` : "";
  if (!useHour12()) return { main: String(parts.hour), sub: minutes };
  const h = parts.hour % 12 || 12;
  return { main: String(h), sub: `${minutes}${parts.hour < 12 ? "am" : "pm"}` };
}

function statusText(status) {
  if (status.working) return "working";
  if (status.night) return "night";
  if (status.weekend) return "day off";
  return "off work";
}

function weekdayNames(style) {
  const monday = Date.UTC(2024, 0, 1, 12);
  return [1, 2, 3, 4, 5, 6, 7].map((d) =>
    new Intl.DateTimeFormat(locale(), { weekday: style, timeZone: "UTC" }).format(
      monday + (d - 1) * tz.DAY,
    ),
  );
}

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 3500);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    window.prompt("Copy this:", text);
  }
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------- persistence

function fragment(at = null) {
  return tz.encodeState({ settings: state.settings, people: state.people, at }, [
    tz.DEFAULT_SETTINGS,
    state.defaults.settings,
  ]);
}

function readSaved() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) return null;
    const decoded = tz.decodeState(saved, LOCAL_TZ, state.defaults.settings);
    return { settings: decoded.settings, people: decoded.people ?? [] };
  } catch {
    return null;
  }
}

function writeSaved() {
  try {
    localStorage.setItem(STORAGE_KEY, fragment());
  } catch {
    // Storage can be unavailable (private mode); the link still holds everything.
  }
}

/** Mirror state into the URL (always) and local storage (own team only). */
function persist() {
  const text = fragment();
  history.replaceState(null, "", text ? `#${text}` : location.pathname + location.search);
  if (state.source === "saved") writeSaved();
}

function applyState({ settings, people }) {
  state.settings = { ...settings };
  state.people = people.map((p) => ({ ...p }));
  formatters.clear();
}

async function loadDefaults() {
  try {
    const response = await fetch("config.json", { cache: "no-cache" });
    const config = await response.json();
    return {
      settings: tz.parseSettings(config.settings ?? {}),
      people: (config.people ?? []).map((p) => tz.normalizePerson(p, LOCAL_TZ)).filter(Boolean),
    };
  } catch {
    return {
      settings: { ...tz.DEFAULT_SETTINGS },
      people: [tz.normalizePerson({ name: "Me", tz: "auto" }, LOCAL_TZ)],
    };
  }
}

function loadFromLocation() {
  const hasFragment = location.hash.length > 1;
  const saved = readSaved();
  const base = saved ?? state.defaults;
  // A link with people is self-contained (over the host defaults). A link
  // with only settings, e.g. "#theme=dark", tweaks the viewer's own team.
  const hasPeople = tz.decodeState(location.hash, LOCAL_TZ).people !== null;
  const linked = tz.decodeState(
    location.hash,
    LOCAL_TZ,
    hasPeople ? state.defaults.settings : base.settings,
  );
  if (hasFragment) {
    applyState({ settings: linked.settings, people: linked.people ?? base.people });
    const differs = saved && fragment() !== tz.encodeState(saved, [tz.DEFAULT_SETTINGS, state.defaults.settings]);
    state.source = differs ? "link" : "saved";
  } else {
    applyState(saved ?? state.defaults);
    state.source = "saved";
  }
  state.selected = linked.at;
  state.date = dateFor(linked.at ?? Date.now());
}

// ------------------------------------------------------------------ dates

/** The timeline date (reference zone) whose columns contain `instant`. */
function dateFor(instant) {
  const zone = ref().tz;
  const date = tz.dateInZone(instant, zone);
  const start = tz.wallTimeToInstant(date, state.settings.from * 60, zone);
  return instant < start ? tz.addDays(date, -1) : date;
}

function columns() {
  return tz.dayColumns(state.date, ref().tz, state.settings.from * 60);
}

function currentColumn(cols) {
  const now = Date.now();
  return cols.findIndex((t) => now >= t && now < t + tz.HOUR);
}

// -------------------------------------------------------------- appearance

function applyAppearance() {
  const s = state.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.font = s.font;
  root.lang = locale();
  $('meta[name="color-scheme"]').content = s.theme === "auto" ? "light dark" : s.theme;

  const colors = [
    [s.accent, "--accent", "--accent-text"],
    [s.workColor, "--work-bg", "--work-text"],
    [s.awakeColor, "--off-bg", "--off-text"],
    [s.nightColor, "--night-bg", "--night-text"],
  ];
  for (const [color, bgVar, textVar] of colors) {
    if (color) {
      root.style.setProperty(bgVar, color);
      root.style.setProperty(textVar, tz.readableTextColor(color));
    } else {
      root.style.removeProperty(bgVar);
      root.style.removeProperty(textVar);
    }
  }
  // A custom accent tints the working-hour cells; keep their text neutral so
  // it stays readable whatever the accent is.
  if (s.accent && !s.workColor) root.style.setProperty("--work-text", "var(--text)");

  $("#legend-night").textContent =
    `Night (${tz.formatHM(s.nightStart)}–${tz.formatHM(s.nightEnd)})`;
  const example = Date.UTC(2024, 0, 1, 15);
  const { main, sub } = hourLabel({ hour: 15, minute: 0 });
  $("#hint-example").textContent =
    `${main}${sub} = ${fmtTime(example, "UTC")}–${fmtTime(example + tz.HOUR, "UTC")}`;
}

// ---------------------------------------------------------------- rendering

function renderHeader() {
  const title = state.settings.title || "TimeFriendZone";
  $("#title").textContent = title;
  document.title = state.settings.title ? `${state.settings.title} · TimeFriendZone` : "TimeFriendZone";
  $("#date").value = state.date;
  $("#today").disabled = state.date === dateFor(Date.now());
  $("#shared-banner").hidden = state.source !== "link";
  $("#sort-select").value = state.settings.sort;
}

function personHeader(person, index, now) {
  const offset = tz.offsetMinutes(now, person.tz);
  const diff = offset - tz.offsetMinutes(now, ref().tz);
  const status = tz.slotStatus(now, person, state.settings);
  const hours = tz.effectiveHours(person, state.settings);
  const name = escapeHtml(person.name);
  const dayNames = weekdayNames("long");
  const workDays =
    hours.days.length === 7 ? "every day" : [...hours.days].map((d) => dayNames[d - 1]).join(", ") || "no days";
  return `
    <th scope="row" class="person">
      <div class="person-line">
        <span class="person-name" title="${name}">${name}</span>
        <span class="person-actions">
          <button type="button" class="mini" data-action="edit" data-index="${index}" aria-label="Edit ${name}" title="Edit">✎</button>
          ${
            index > 0
              ? `<button type="button" class="mini" data-action="ref" data-index="${index}" aria-label="Use ${name}'s time zone as the reference" title="Use as reference">⌂</button>`
              : ""
          }
          ${
            index > 0 && state.settings.sort === "custom"
              ? `<button type="button" class="mini" data-action="up" data-index="${index}" aria-label="Move ${name} up" title="Move up">↑</button>`
              : ""
          }
          <button type="button" class="mini" data-action="remove" data-index="${index}" aria-label="Remove ${name}" title="Remove">✕</button>
        </span>
      </div>
      <div class="person-meta">
        ${escapeHtml(tz.cityName(person.tz))} · ${tz.formatOffset(offset)} ·
        <span class="lead">${index === 0 ? "reference" : tz.formatLead(diff)}</span>
      </div>
      <div class="person-now">
        <span class="clock">${escapeHtml(fmtTime(now, person.tz))}</span>
        <span class="status status-${status.working ? "work" : status.night ? "night" : "off"}">${statusText(status)}</span>
      </div>
      <span class="sr-only">Works ${tz.formatHM(hours.start)}–${tz.formatHM(hours.end)} local time on ${escapeHtml(workDays)}.</span>
    </th>`;
}

function renderGrid() {
  const cols = columns();
  const people = state.people;
  const counts = tz.availability(cols, people, state.settings);
  const nowCol = currentColumn(cols);
  const now = Date.now();
  const refZone = ref().tz;
  const selectedCol = cols.indexOf(state.selected);
  const fallbackCol = cols.findIndex((t) => tz.zonedParts(t, refZone).hour === 9);
  const focusCol = selectedCol >= 0 ? selectedCol : nowCol >= 0 ? nowCol : Math.max(0, fallbackCol);
  const nowStyle =
    nowCol >= 0 ? ` style="--now-pos:${(((now - cols[nowCol]) / tz.HOUR) * 100).toFixed(1)}%"` : "";

  const headCells = cols
    .map((t, i) => {
      const n = counts[i];
      const total = people.length;
      const all = total > 0 && n === total;
      // Partial overlap tints the chip up to 45% of the accent; "all" is solid.
      const level = total === 0 ? 0 : Math.round((n / total) * 45);
      const label = `${fmtTime(t, refZone)}–${fmtTime(t + tz.HOUR, refZone)} ${tz.cityName(refZone)}: ${n} of ${total} working`;
      const classes = ["slot"];
      if (all) classes.push("all");
      if (i === nowCol) classes.push("now");
      if (i === selectedCol) classes.push("selected");
      return `<th scope="col" class="${classes.join(" ")}"${i === nowCol ? nowStyle : ""}>
        <button type="button" class="slot-button" data-col="${i}" tabindex="${i === focusCol ? 0 : -1}"
          style="--level:${level}%" aria-pressed="${i === selectedCol}" aria-label="${escapeHtml(label)}"
          title="${escapeHtml(label)}"><span aria-hidden="true">${all ? "All" : n > 0 ? n : ""}</span></button>
      </th>`;
    })
    .join("");

  const rows = tz
    .sortOrder(people, state.settings.sort, now)
    .map((index) => {
      const person = people[index];
      const cells = cols
        .map((t, i) => {
          const status = tz.slotStatus(t, person, state.settings);
          const { parts } = status;
          const classes = ["cell"];
          if (status.working) classes.push("work");
          else if (status.night) classes.push("night");
          else classes.push("off");
          const dayStart = parts.hour === 0 || i === 0;
          if (parts.hour === 0 && i > 0) classes.push("daystart");
          if (i === nowCol) classes.push("now");
          if (i === selectedCol) classes.push("selected");
          const { main, sub } = hourLabel(parts);
          const day = dayStart ? escapeHtml(fmtShortDay(t, person.tz)) : "";
          const range = `${fmtTime(t, person.tz)}–${fmtTime(t + tz.HOUR, person.tz)}, ${statusText(status)}`;
          return `<td class="${classes.join(" ")}"${i === nowCol ? nowStyle : ""} title="${escapeHtml(range)}"><span class="day">${day}</span><span class="hour">${main}</span><span class="sub">${sub}</span><span class="sr-only">, ${statusText(status)}</span></td>`;
        })
        .join("");
      return `<tr>${personHeader(person, index, now)}${cells}</tr>`;
    })
    .join("");

  const caption = `Local times for each person from ${fmtLongDate(cols[0], refZone)}, one column per hour of ${tz.cityName(refZone)} time. The first row counts how many people are working.`;
  const empty =
    people.length === 0
      ? `<tr><td class="empty" colspan="${cols.length + 1}">Nobody here yet. Use “Add person” to start with yourself.</td></tr>`
      : "";

  $("#grid").innerHTML = `
    <caption class="sr-only">${escapeHtml(caption)}</caption>
    <thead><tr><th scope="col" class="corner"><span>Working</span><small>${escapeHtml(fmtDay(cols[0], refZone))}</small></th>${headCells}</tr></thead>
    <tbody>${rows}${empty}</tbody>`;

  renderBest(cols, counts);
}

function windowLabel(cols, [from, to]) {
  const zone = ref().tz;
  return `${fmtTime(cols[from], zone)}–${fmtTime(cols[to - 1] + tz.HOUR, zone)}`;
}

function renderBest(cols, counts) {
  const el = $("#best");
  const total = state.people.length;
  if (total < 2) {
    el.textContent = "";
    return;
  }
  const { max, windows } = tz.bestWindows(counts);
  const zone = tz.cityName(ref().tz);
  if (max === 0) {
    el.textContent = "Nobody is working on this day.";
    return;
  }
  const lead = max === total ? "Everyone is working" : `Best overlap: ${max} of ${total} working`;
  const buttons = windows
    .map(
      (w) =>
        `<button type="button" class="link-button" data-col="${w[0]}">${escapeHtml(windowLabel(cols, w))}</button>`,
    )
    .join(", ");
  el.innerHTML = `${lead} ${buttons} <span class="muted">(${escapeHtml(zone)} time)</span>`;
}

function selectionSummary() {
  const start = state.selected;
  const end = start + tz.HOUR;
  const zone = ref().tz;
  const order = tz.sortOrder(state.people, state.settings.sort, start);
  const lines = order.map((i) => state.people[i]).map((person) => {
    const status = tz.slotStatus(start, person, state.settings);
    return {
      person,
      status,
      text: `${person.name}: ${fmtDay(start, person.tz)}, ${fmtTime(start, person.tz)}–${fmtTime(end, person.tz)} (${tz.cityName(person.tz)}, ${statusText(status)})`,
    };
  });
  const working = lines.filter((l) => l.status.working).length;
  const heading = `${fmtDay(start, zone)}, ${fmtTime(start, zone)}–${fmtTime(end, zone)}`;
  return { start, end, zone, lines, working, heading };
}

function renderSelection() {
  const el = $("#selection");
  if (state.selected === null || !columns().includes(state.selected)) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const s = selectionSummary();
  const items = s.lines
    .map(
      ({ person, status }) => `
      <li class="${status.working ? "is-work" : status.night ? "is-night" : "is-off"}">
        <span class="sel-name">${escapeHtml(person.name)}</span>
        <span class="sel-time">${escapeHtml(fmtTime(s.start, person.tz))}–${escapeHtml(fmtTime(s.end, person.tz))}</span>
        <span class="sel-day">${escapeHtml(fmtDay(s.start, person.tz))}</span>
        <span class="sel-status">${statusText(status)}</span>
      </li>`,
    )
    .join("");
  el.innerHTML = `
    <div class="section-head">
      <h2 id="selection-heading">${escapeHtml(s.heading)} <span class="muted">${escapeHtml(tz.cityName(s.zone))} time</span></h2>
      <p>${s.working} of ${s.lines.length} within working hours</p>
    </div>
    <ul class="sel-list">${items}</ul>
    <div class="sel-actions">
      <button type="button" data-sel="copy">Copy as text</button>
      <button type="button" data-sel="link">Copy link to this time</button>
      <button type="button" data-sel="ics">Download calendar invite (.ics)</button>
      <button type="button" data-sel="clear">Clear selection</button>
    </div>`;
}

/** Selector that finds the focused control again after its HTML is rebuilt. */
function focusSelector() {
  const el = document.activeElement;
  const container = el?.closest("#grid, #best, #selection");
  if (!container || Object.keys(el.dataset).length === 0) return null;
  const attrs = Object.entries(el.dataset)
    .map(([key, value]) => `[data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"]`)
    .join("");
  return `#${container.id} ${el.tagName.toLowerCase()}${attrs}`;
}

function render() {
  const selector = focusSelector();
  applyAppearance();
  renderHeader();
  renderGrid();
  renderSelection();
  if (selector) $(selector)?.focus({ preventScroll: true });
}

/** Scroll the timeline so the selected or current hour is centred. */
function scrollToFocusColumn() {
  const scroller = $("#grid-scroll");
  const target = $(".slot-button[tabindex='0']")?.closest("th");
  const sticky = $("#grid .corner");
  if (!target || !sticky) return;
  const visible = scroller.clientWidth - sticky.offsetWidth;
  const left = target.offsetLeft - sticky.offsetWidth - (visible - target.offsetWidth) / 2;
  scroller.scrollLeft = Math.max(0, left);
}

// ----------------------------------------------------------------- actions

function selectColumn(index, toggle = false) {
  const t = columns()[index];
  if (t === undefined) return;
  state.selected = toggle && state.selected === t ? null : t;
  render();
  if (state.selected !== null) {
    const s = selectionSummary();
    toast(`${s.heading} ${tz.cityName(s.zone)}: ${s.working} of ${s.lines.length} working`);
  }
}

function setDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
  // Keep the same time of day selected when moving between days.
  let selectedMinutes = null;
  if (state.selected !== null) {
    const p = tz.zonedParts(state.selected, ref().tz);
    selectedMinutes = p.hour * 60 + p.minute;
  }
  state.date = dateStr;
  state.selected = null;
  if (selectedMinutes !== null) {
    const candidate = tz.wallTimeToInstant(dateStr, selectedMinutes, ref().tz);
    const cols = columns();
    // With a late timeline start, early hours belong to the next calendar day.
    const next = tz.wallTimeToInstant(tz.addDays(dateStr, 1), selectedMinutes, ref().tz);
    state.selected = cols.includes(candidate) ? candidate : cols.includes(next) ? next : null;
  }
  render();
  scrollToFocusColumn();
}

/** Apply a change to settings or team, keeping the visible day sensible. */
function change(mutator) {
  const refZoneBefore = ref().tz;
  const fromBefore = state.settings.from;
  const anchor = state.selected ?? columns()[0] + 12 * tz.HOUR;
  mutator();
  formatters.clear();
  if (ref().tz !== refZoneBefore || state.settings.from !== fromBefore) {
    state.date = dateFor(anchor);
    if (state.selected !== null && !columns().includes(state.selected)) state.selected = null;
  }
  persist();
  render();
}

// --------------------------------------------------------------- day boxes

function dayBoxes(container, name) {
  const short = weekdayNames("short");
  const long = weekdayNames("long");
  container.innerHTML = short
    .map(
      (label, i) =>
        `<label class="day-box"><input type="checkbox" name="${name}" value="${i + 1}" aria-label="${escapeHtml(long[i])}"><span aria-hidden="true">${escapeHtml(label)}</span></label>`,
    )
    .join("");
}

function readDays(form, name) {
  return [...form.querySelectorAll(`input[name='${name}']:checked`)].map((b) => b.value).join("");
}

function writeDays(form, name, days) {
  for (const box of form.querySelectorAll(`input[name='${name}']`)) box.checked = days.includes(box.value);
}

// ------------------------------------------------------------ person dialog

let editingIndex = null;

function syncPersonDefaultToggle() {
  const form = $("#person-form");
  const useDefault = form.elements.useDefault.checked;
  $("#person-hours").disabled = useDefault;
  if (useDefault) {
    form.elements.start.value = tz.toTimeInput(state.settings.workStart);
    form.elements.end.value = tz.toTimeInput(state.settings.workEnd);
    writeDays(form, "day", state.settings.workDays);
  }
}

function openPersonDialog(index = null) {
  editingIndex = index;
  const form = $("#person-form");
  const person =
    index === null
      ? { name: state.people.length === 0 ? "Me" : "", tz: state.people.length === 0 ? LOCAL_TZ : "" }
      : state.people[index];
  const hours = tz.effectiveHours(person, state.settings);
  $("#person-dialog-title").textContent = index === null ? "Add person" : `Edit ${person.name}`;
  dayBoxes($("#day-boxes"), "day");
  form.elements.name.value = person.name;
  form.elements.tz.value = person.tz;
  form.elements.useDefault.checked = person.start === undefined && person.days === undefined;
  form.elements.start.value = tz.toTimeInput(hours.start);
  form.elements.end.value = tz.toTimeInput(hours.end);
  writeDays(form, "day", hours.days);
  $("#team-default-label").textContent =
    `Use the team default (${tz.formatHM(state.settings.workStart)}–${tz.formatHM(state.settings.workEnd)})`;
  syncPersonDefaultToggle();
  $("#person-error").textContent = "";
  $("#person-dialog").showModal();
  form.elements.name.focus();
}

function savePersonFromForm() {
  const form = $("#person-form");
  const name = form.elements.name.value.trim();
  const zone = tz.resolveTimeZone(form.elements.tz.value, ZONES);
  const start = tz.fromTimeInput(form.elements.start.value);
  const end = tz.fromTimeInput(form.elements.end.value);
  const error = (message, field) => {
    $("#person-error").textContent = message;
    field?.focus();
    return false;
  };
  if (!name) return error("Please enter a name.", form.elements.name);
  if (!zone) {
    return error(
      `“${form.elements.tz.value}” is not a known city or time zone. Try a nearby major city or pick one from the list.`,
      form.elements.tz,
    );
  }
  const person = { name: name.slice(0, 80), tz: zone };
  if (!form.elements.useDefault.checked) {
    if (start === null || end === null) return error("Please enter working hours.", form.elements.start);
    Object.assign(person, { start, end, days: readDays(form, "day") });
  }
  change(() => {
    if (editingIndex === null) state.people.push(person);
    else state.people[editingIndex] = person;
  });
  toast(`${editingIndex === null ? "Added" : "Updated"} ${person.name} (${tz.cityName(zone)}).`);
  return true;
}

function setupPersonDialog() {
  $("#zones").innerHTML = [
    ...ZONES.map((zone) => `<option value="${zone}">${escapeHtml(tz.cityName(zone))}</option>`),
    ...Object.entries(tz.CITY_ALIASES)
      .filter(([, zone]) => zone !== "UTC")
      .map(
        ([city, zone]) =>
          `<option value="${zone}">${escapeHtml(city.replace(/\b\w/g, (c) => c.toUpperCase()))}</option>`,
      ),
  ].join("");

  const form = $("#person-form");
  form.elements.useDefault.addEventListener("change", syncPersonDefaultToggle);
  form.addEventListener("submit", (event) => {
    if (event.submitter?.value === "save" && !savePersonFromForm()) event.preventDefault();
  });
}

// ---------------------------------------------------------- settings dialog

const COLOR_FIELDS = {
  accent: { setting: "accent", cssVar: "--accent" },
  workColor: { setting: "workColor", cssVar: "--work-bg" },
  awakeColor: { setting: "awakeColor", cssVar: "--off-bg" },
  nightColor: { setting: "nightColor", cssVar: "--night-bg" },
};

/** Current computed colour of a CSS variable as #rrggbb (for colour inputs). */
function computedHex(cssVar) {
  // Painting the colour onto a canvas handles every CSS colour syntax,
  // including color-mix() results.
  const probe = document.createElement("span");
  probe.style.color = `var(${cssVar})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function fillSettingsForm() {
  const form = $("#settings-form");
  const s = state.settings;
  form.elements.title.value = s.title;
  form.elements.hour12.value = s.hour12 === null ? "auto" : s.hour12 ? "12" : "24";
  form.elements.lang.value = s.lang;
  form.elements.lang.placeholder = BROWSER_LOCALE;
  form.elements.theme.value = s.theme;
  form.elements.font.value = s.font;
  form.elements.sort.value = s.sort;
  form.elements.from.value = String(s.from);
  form.elements.nightStart.value = tz.toTimeInput(s.nightStart);
  form.elements.nightEnd.value = tz.toTimeInput(s.nightEnd);
  form.elements.workStart.value = tz.toTimeInput(s.workStart);
  form.elements.workEnd.value = tz.toTimeInput(s.workEnd);
  dayBoxes($("#work-day-boxes"), "workDay");
  writeDays(form, "workDay", s.workDays);
  for (const [field, { setting, cssVar }] of Object.entries(COLOR_FIELDS)) {
    form.elements[field].value = s[setting] || computedHex(cssVar);
    form.querySelector(`[data-reset="${field}"]`).disabled = !s[setting];
  }
}

function readSettingsForm(changedField) {
  const form = $("#settings-form");
  const value = (name) => form.elements[name].value;
  const minutes = (name, fallback) => tz.fromTimeInput(value(name)) ?? fallback;
  const s = state.settings;
  const lang = value("lang").trim();
  const next = {
    ...s,
    title: value("title").trim().slice(0, 120),
    hour12: value("hour12") === "auto" ? null : value("hour12") === "12",
    lang: lang === "" || tz.parseSettings({ lang }).lang === lang ? lang : s.lang,
    theme: value("theme"),
    font: value("font"),
    sort: value("sort"),
    from: Number(value("from")),
    nightStart: minutes("nightStart", s.nightStart),
    nightEnd: minutes("nightEnd", s.nightEnd),
    workStart: minutes("workStart", s.workStart),
    workEnd: minutes("workEnd", s.workEnd),
    workDays: readDays(form, "workDay"),
  };
  // Only a colour the user actually touched becomes custom.
  if (COLOR_FIELDS[changedField]) {
    next[COLOR_FIELDS[changedField].setting] = tz.parseColor(value(changedField));
  }
  return next;
}

function setupSettingsDialog() {
  const dialog = $("#settings-dialog");
  const form = $("#settings-form");

  for (let h = 0; h < 24; h++) {
    form.elements.from.add(new Option(`${String(h).padStart(2, "0")}:00`, String(h)));
  }
  $("#locales").innerHTML = [
    "en-GB", "en-US", "de-DE", "fr-FR", "es-ES", "it-IT", "nl-NL", "pt-BR", "pt-PT", "sv-SE",
    "da-DK", "nb-NO", "fi-FI", "pl-PL", "cs-CZ", "uk-UA", "tr-TR", "ja-JP", "ko-KR", "zh-CN",
    "hi-IN", "ar-EG", "he-IL",
  ]
    .map((l) => `<option value="${l}"></option>`)
    .join("");

  $("#open-settings").addEventListener("click", () => {
    fillSettingsForm();
    dialog.showModal();
  });

  const onEdit = (event) => {
    const field = event.target.name;
    if (!field) return;
    if (field === "lang" && event.type === "input") return; // wait for change
    change(() => {
      state.settings = readSettingsForm(field);
    });
    if (field === "lang" || field === "theme") fillSettingsForm();
    if (COLOR_FIELDS[field]) form.querySelector(`[data-reset="${field}"]`).disabled = false;
  };
  form.addEventListener("input", onEdit);
  form.addEventListener("change", onEdit);

  form.addEventListener("click", (event) => {
    const field = event.target.closest("[data-reset]")?.dataset.reset;
    if (!field) return;
    change(() => {
      state.settings[COLOR_FIELDS[field].setting] = "";
    });
    fillSettingsForm();
  });

  $("#copy-link").addEventListener("click", () => {
    persist();
    copyText(location.href, "Link copied. It reproduces this exact view, settings included.");
  });

  $("#sort-team").addEventListener("click", () => {
    const now = Date.now();
    change(() => {
      state.people.sort((a, b) => tz.offsetMinutes(now, a.tz) - tz.offsetMinutes(now, b.tz));
    });
    toast("Team sorted from west to east.");
  });

  $("#export-team").addEventListener("click", () => {
    const settings = Object.fromEntries(tz.settingsToParams(state.settings));
    const json = JSON.stringify({ settings, people: state.people.map(tz.personToJson) }, null, 2);
    download("config.json", `${json}\n`, "application/json");
  });

  $("#import-team").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const people = (data.people ?? []).map((p) => tz.normalizePerson(p, LOCAL_TZ)).filter(Boolean);
      if (people.length === 0) throw new Error("no people");
      change(() => {
        state.people = people;
        if (data.settings) state.settings = tz.parseSettings(data.settings);
      });
      fillSettingsForm();
      toast(`Imported ${people.length} people.`);
    } catch {
      toast("That file does not look like an exported team.");
    }
  });

  $("#reset-settings").addEventListener("click", () => {
    change(() => {
      state.settings = { ...state.defaults.settings };
    });
    fillSettingsForm();
    toast("Settings reset to the defaults.");
  });

  $("#reset-team").addEventListener("click", () => {
    if (!window.confirm("Replace your team with the default team? This cannot be undone.")) return;
    change(() => {
      state.people = state.defaults.people.map((p) => ({ ...p }));
    });
    toast("Team reset to the default.");
  });
}

// ------------------------------------------------------------------ events

function setupEvents() {
  $("#prev-day").addEventListener("click", () => setDate(tz.addDays(state.date, -1)));
  $("#next-day").addEventListener("click", () => setDate(tz.addDays(state.date, 1)));
  $("#today").addEventListener("click", () => {
    state.selected = null;
    setDate(dateFor(Date.now()));
  });
  $("#date").addEventListener("change", (e) => setDate(e.target.value));
  $("#add-person").addEventListener("click", () => openPersonDialog());
  $("#sort-select").addEventListener("change", (e) => {
    change(() => {
      state.settings.sort = e.target.value;
    });
  });

  $("#share").addEventListener("click", () => {
    persist();
    copyText(location.href, "Link copied. Anyone with it sees this exact view; names never reach a server.");
  });

  $("#grid").addEventListener("click", (event) => {
    const slot = event.target.closest(".slot-button");
    if (slot) {
      selectColumn(Number(slot.dataset.col), true);
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const index = Number(button.dataset.index);
    const person = state.people[index];
    if (button.dataset.action === "edit") openPersonDialog(index);
    if (button.dataset.action === "ref") {
      change(() => {
        state.people.unshift(...state.people.splice(index, 1));
      });
      toast(`Times now shown relative to ${person.name} (${tz.cityName(person.tz)}).`);
      $(`button[data-action="edit"][data-index="0"]`)?.focus();
    }
    if (button.dataset.action === "up") {
      change(() => {
        [state.people[index - 1], state.people[index]] = [state.people[index], state.people[index - 1]];
      });
      ($(`button[data-action="up"][data-index="${index - 1}"]`) ?? $(`button[data-action="edit"][data-index="0"]`))?.focus();
    }
    if (button.dataset.action === "remove") {
      change(() => state.people.splice(index, 1));
      toast(`Removed ${person.name}.`);
      $("#add-person").focus();
    }
  });

  // Roving focus across the hour buttons, like a toolbar.
  $("#grid").addEventListener("keydown", (event) => {
    const slot = event.target.closest(".slot-button");
    if (!slot) return;
    const count = columns().length;
    const col = Number(slot.dataset.col);
    const next = { ArrowLeft: col - 1, ArrowRight: col + 1, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = Math.min(count - 1, Math.max(0, next));
    selectColumn(target);
    const button = $(`.slot-button[data-col="${target}"]`);
    button?.focus();
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  $("#best").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-col]");
    if (button) selectColumn(Number(button.dataset.col));
  });

  $("#selection").addEventListener("click", (event) => {
    const action = event.target.closest("button[data-sel]")?.dataset.sel;
    if (!action) return;
    const s = selectionSummary();
    const text = [`${s.heading} (${tz.cityName(s.zone)} time)`, ...s.lines.map((l) => `• ${l.text}`)].join("\n");
    if (action === "copy") copyText(text, "Times copied.");
    if (action === "link") {
      copyText(`${location.origin}${location.pathname}#${fragment(s.start)}`, "Link to this time copied.");
    }
    if (action === "ics") {
      const ics = tz.toIcs({
        start: s.start,
        end: s.end,
        summary: state.settings.title || "Meeting",
        description: text,
        uid: `${s.start}-${Math.random().toString(36).slice(2)}@timefriendzone`,
      });
      download("meeting.ics", ics, "text/calendar");
    }
    if (action === "clear") {
      state.selected = null;
      render();
      $(".slot-button[tabindex='0']")?.focus();
    }
  });

  $("#adopt-shared").addEventListener("click", () => {
    state.source = "saved";
    writeSaved();
    render();
    toast("Saved as your team.");
  });

  $("#restore-saved").addEventListener("click", () => {
    applyState(readSaved() ?? state.defaults);
    state.source = "saved";
    state.selected = null;
    state.date = dateFor(Date.now());
    persist();
    render();
  });

  window.addEventListener("hashchange", () => {
    if (location.hash.slice(1) === fragment()) return;
    loadFromLocation();
    render();
    scrollToFocusColumn();
  });

  // Keep clocks and the "now" marker current.
  let lastMinute = -1;
  setInterval(() => {
    const minute = Math.floor(Date.now() / tz.MINUTE);
    if (minute === lastMinute) return;
    lastMinute = minute;
    if (!document.querySelector("dialog[open]")) render();
  }, 5_000);
}

function setupSourceLink() {
  // Forks served from https://<user>.github.io/<repo>/ link to their own repository.
  const match = /^([\w-]+)\.github\.io$/.exec(location.hostname);
  if (!match) return;
  const repo = location.pathname.split("/").filter(Boolean)[0] ?? `${match[1]}.github.io`;
  const link = $("#source-link");
  link.href = `https://github.com/${match[1]}/${repo}`;
}

async function main() {
  state.defaults = await loadDefaults();
  loadFromLocation();
  setupPersonDialog();
  setupSettingsDialog();
  setupEvents();
  setupSourceLink();
  render();
  scrollToFocusColumn();
}

main();
