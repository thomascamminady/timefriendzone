import * as tz from "./tz.js";

const STORAGE_KEY = "timefriendzone:v1";
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const LOCALE = navigator.language || "en";
const DEVICE_HOUR12 = /^h1[12]$/.test(
  new Intl.DateTimeFormat(LOCALE, { hour: "numeric" }).resolvedOptions().hourCycle ?? "",
);

const ZONES = (() => {
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  return zones.includes("UTC") ? zones : [...zones, "UTC"];
})();

const $ = (selector) => document.querySelector(selector);

const state = {
  title: "",
  people: [],
  hour12: null, // null = follow the device
  date: "", // YYYY-MM-DD in the reference (first) person's zone
  selected: null, // instant of the selected column
  source: "saved", // "saved" | "link"
  defaults: { title: "", people: [] },
};

// ----------------------------------------------------------------- helpers

const ref = () => state.people[0] ?? { name: "You", tz: LOCAL_TZ };
const useHour12 = () => state.hour12 ?? DEVICE_HOUR12;

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const formatters = new Map();
function format(instant, timeZone, options) {
  const key = JSON.stringify([timeZone, options, useHour12()]);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, { timeZone, hour12: useHour12(), ...options });
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

function teamSnapshot() {
  return { title: state.title, people: state.people, hour12: state.hour12 };
}

function readSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || !Array.isArray(raw.people)) return null;
    return {
      title: typeof raw.title === "string" ? raw.title : "",
      people: raw.people.map((p) => tz.normalizePerson(p, LOCAL_TZ)).filter(Boolean),
      hour12: typeof raw.hour12 === "boolean" ? raw.hour12 : null,
    };
  } catch {
    return null;
  }
}

function writeSaved() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(teamSnapshot()));
  } catch {
    // Storage can be unavailable (private mode); the link still holds the team.
  }
}

function sameTeam(a, b) {
  return tz.encodeState({ ...a, hour12: null }) === tz.encodeState({ ...b, hour12: null });
}

/** Mirror state into the URL (always) and local storage (own team only). */
function persist() {
  const fragment = tz.encodeState(teamSnapshot());
  history.replaceState(null, "", fragment ? `#${fragment}` : location.pathname + location.search);
  if (state.source === "saved") writeSaved();
}

function applyTeam(team) {
  state.title = team.title ?? "";
  state.people = team.people;
  state.hour12 = team.hour12 ?? null;
  formatters.clear();
}

async function loadDefaults() {
  try {
    const response = await fetch("config.json", { cache: "no-cache" });
    const config = await response.json();
    return {
      title: typeof config.title === "string" ? config.title : "",
      people: (config.people ?? []).map((p) => tz.normalizePerson(p, LOCAL_TZ)).filter(Boolean),
      hour12: typeof config.hour12 === "boolean" ? config.hour12 : null,
    };
  } catch {
    return { title: "", people: [tz.normalizePerson({ name: "Me", tz: "auto" }, LOCAL_TZ)] };
  }
}

function loadFromLocation() {
  const linked = tz.decodeState(location.hash, LOCAL_TZ);
  const saved = readSaved();
  if (linked.people) {
    applyTeam({ title: linked.title, people: linked.people, hour12: linked.hour12 });
    state.source = saved && !sameTeam(saved, linked) ? "link" : "saved";
  } else if (saved) {
    applyTeam(saved);
    state.source = "saved";
  } else {
    applyTeam(state.defaults);
    state.source = "saved";
  }
  state.selected = linked.at;
  state.date = tz.dateInZone(linked.at ?? Date.now(), ref().tz);
}

// ---------------------------------------------------------------- rendering

function columns() {
  return tz.dayColumns(state.date, ref().tz);
}

function currentColumn(cols) {
  const now = Date.now();
  return cols.findIndex((t) => now >= t && now < t + tz.HOUR);
}

function renderHeader() {
  const title = state.title || "TimeFriendZone";
  $("#title").textContent = title;
  document.title = state.title ? `${state.title} · TimeFriendZone` : "TimeFriendZone";
  $("#date").value = state.date;
  $("#today").disabled = state.date === tz.dateInZone(Date.now(), ref().tz);
  $("#shared-banner").hidden = state.source !== "link";
}

function personHeader(person, index, now) {
  const offset = tz.offsetMinutes(now, person.tz);
  const diff = offset - tz.offsetMinutes(now, ref().tz);
  const status = tz.slotStatus(now, person);
  const name = escapeHtml(person.name);
  const workDays = person.days.length === 7 ? "every day" : `${person.days.length} days/week`;
  return `
    <th scope="row" class="person">
      <div class="person-line">
        <span class="person-name">${name}</span>
        <span class="person-actions">
          <button type="button" class="mini" data-action="edit" data-index="${index}" aria-label="Edit ${name}" title="Edit">✎</button>
          ${
            index > 0
              ? `<button type="button" class="mini" data-action="up" data-index="${index}" aria-label="Move ${name} up${index === 1 ? " (makes them the reference time zone)" : ""}" title="Move up">↑</button>`
              : ""
          }
          <button type="button" class="mini" data-action="remove" data-index="${index}" aria-label="Remove ${name}" title="Remove">✕</button>
        </span>
      </div>
      <div class="person-meta">
        ${escapeHtml(tz.cityName(person.tz))} · ${tz.formatOffset(offset)}${
          index === 0 ? ` · <span class="ref-tag">reference</span>` : ` · ${tz.formatDiff(diff)}`
        }
      </div>
      <div class="person-now">
        <span class="clock">${escapeHtml(fmtTime(now, person.tz))}</span>
        <span class="status status-${status.working ? "work" : status.night ? "night" : "off"}">${statusText(status)}</span>
      </div>
      <span class="sr-only">Works ${tz.formatHM(person.start)}–${tz.formatHM(person.end)} local time, ${workDays}.</span>
    </th>`;
}

function renderGrid() {
  const cols = columns();
  const people = state.people;
  const counts = tz.availability(cols, people);
  const nowCol = currentColumn(cols);
  const now = Date.now();
  const refZone = ref().tz;
  const selectedCol = cols.indexOf(state.selected);
  const focusCol = selectedCol >= 0 ? selectedCol : nowCol >= 0 ? nowCol : 9;
  const nowStyle =
    nowCol >= 0 ? ` style="--now-pos:${(((now - cols[nowCol]) / tz.HOUR) * 100).toFixed(1)}%"` : "";

  const headCells = cols
    .map((t, i) => {
      const n = counts[i];
      const level = people.length === 0 ? 0 : n / people.length;
      const label = `${fmtTime(t, refZone)} ${tz.cityName(refZone)}: ${n} of ${people.length} working`;
      const classes = ["slot", level === 1 ? "all" : level >= 0.5 ? "most" : n > 0 ? "some" : "none"];
      if (i === nowCol) classes.push("now");
      if (i === selectedCol) classes.push("selected");
      return `<th scope="col" class="${classes.join(" ")}"${i === nowCol ? nowStyle : ""}>
        <button type="button" class="slot-button" data-col="${i}" tabindex="${i === focusCol ? 0 : -1}"
          aria-pressed="${i === selectedCol}" aria-label="${escapeHtml(label)}">
          <span class="count" aria-hidden="true">${n}</span>
          <span class="bar" aria-hidden="true" style="--level:${level}"></span>
        </button>
      </th>`;
    })
    .join("");

  const rows = people
    .map((person, index) => {
      const cells = cols
        .map((t, i) => {
          const status = tz.slotStatus(t, person);
          const { parts } = status;
          const classes = ["cell"];
          if (status.working) classes.push("work");
          else if (status.night) classes.push("night");
          else classes.push("off");
          if (status.weekend) classes.push("weekend");
          const dayStart = parts.hour === 0 || i === 0;
          if (parts.hour === 0 && i > 0) classes.push("daystart");
          if (i === nowCol) classes.push("now");
          if (i === selectedCol) classes.push("selected");
          const { main, sub } = hourLabel(parts);
          return `<td class="${classes.join(" ")}"${i === nowCol ? nowStyle : ""}>${
            dayStart ? `<span class="day">${escapeHtml(fmtShortDay(t, person.tz))}</span>` : ""
          }<span class="hour">${main}</span><span class="sub">${sub}</span><span class="sr-only">, ${statusText(status)}</span></td>`;
        })
        .join("");
      return `<tr>${personHeader(person, index, now)}${cells}</tr>`;
    })
    .join("");

  const caption = `Local times for each person on ${fmtLongDate(cols[0], refZone)}, one column per hour of ${tz.cityName(refZone)} time.`;
  const empty =
    people.length === 0
      ? `<tr><td class="empty" colspan="${cols.length + 1}">Nobody here yet. Use “Add person” to start with yourself.</td></tr>`
      : "";

  $("#grid").innerHTML = `
    <caption class="sr-only">${escapeHtml(caption)}</caption>
    <thead><tr><th scope="col" class="corner"><span>Available</span><small>${escapeHtml(fmtDay(cols[0], refZone))}</small></th>${headCells}</tr></thead>
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
  const lines = state.people.map((person) => {
    const status = tz.slotStatus(start, person);
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
  renderHeader();
  renderGrid();
  renderSelection();
  if (selector) $(selector)?.focus({ preventScroll: true });
}

/** Scroll the timeline so the selected or current hour is in view. */
function scrollToFocusColumn() {
  const scroller = $("#grid-scroll");
  const target = $(".slot-button[tabindex='0']")?.closest("th");
  const sticky = $("#grid .corner");
  if (!target || !sticky) return;
  // Centre the column in the area right of the sticky name column.
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
  state.selected =
    selectedMinutes === null ? null : tz.wallTimeToInstant(dateStr, selectedMinutes, ref().tz);
  render();
  scrollToFocusColumn();
}

function changeTeam(mutator) {
  const refZoneBefore = ref().tz;
  mutator();
  if (ref().tz !== refZoneBefore) {
    // The reference zone changed: re-anchor the visible day on the same instant.
    const anchor = state.selected ?? columns()[0];
    state.date = tz.dateInZone(anchor ?? Date.now(), ref().tz);
    if (state.selected !== null && !columns().includes(state.selected)) state.selected = null;
  }
  persist();
  render();
}

// ------------------------------------------------------------ person dialog

let editingIndex = null;

function openPersonDialog(index = null) {
  editingIndex = index;
  const dialog = $("#person-dialog");
  const form = $("#person-form");
  const person =
    index === null
      ? {
          name: state.people.length === 0 ? "Me" : "",
          tz: state.people.length === 0 ? LOCAL_TZ : "",
          start: tz.DEFAULT_START,
          end: tz.DEFAULT_END,
          days: tz.DEFAULT_DAYS,
        }
      : state.people[index];
  $("#person-dialog-title").textContent = index === null ? "Add person" : `Edit ${person.name}`;
  form.elements.name.value = person.name;
  form.elements.tz.value = person.tz;
  form.elements.start.value = tz.toTimeInput(person.start);
  form.elements.end.value = tz.toTimeInput(person.end);
  for (const box of form.querySelectorAll("input[name='day']")) {
    box.checked = person.days.includes(box.value);
  }
  $("#person-error").textContent = "";
  dialog.showModal();
  form.elements.name.focus();
}

function savePersonFromForm() {
  const form = $("#person-form");
  const name = form.elements.name.value.trim();
  const zone = tz.resolveTimeZone(form.elements.tz.value, ZONES);
  const start = tz.fromTimeInput(form.elements.start.value);
  const end = tz.fromTimeInput(form.elements.end.value);
  const days = [...form.querySelectorAll("input[name='day']:checked")].map((b) => b.value).join("");
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
  if (start === null || end === null) return error("Please enter working hours.", form.elements.start);

  const person = tz.normalizePerson({ name, tz: zone, start, end, days }, LOCAL_TZ);
  changeTeam(() => {
    if (editingIndex === null) state.people.push(person);
    else state.people[editingIndex] = person;
  });
  toast(`${editingIndex === null ? "Added" : "Updated"} ${person.name} (${tz.cityName(zone)}).`);
  return true;
}

function setupPersonDialog() {
  const box = $("#day-boxes");
  const monday = Date.UTC(2024, 0, 1, 12);
  box.innerHTML = [1, 2, 3, 4, 5, 6, 7]
    .map((d) => {
      const t = monday + (d - 1) * tz.DAY;
      const short = new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: "UTC" }).format(t);
      const long = new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: "UTC" }).format(t);
      return `<label class="day-box"><input type="checkbox" name="day" value="${d}" aria-label="${long}"><span aria-hidden="true">${short}</span></label>`;
    })
    .join("");

  $("#zones").innerHTML = [
    ...ZONES.map((zone) => `<option value="${zone}">${escapeHtml(tz.cityName(zone))}</option>`),
    ...Object.entries(tz.CITY_ALIASES)
      .filter(([, zone]) => zone !== "UTC")
      .map(([city, zone]) => `<option value="${zone}">${escapeHtml(city.replace(/\b\w/g, (c) => c.toUpperCase()))}</option>`),
  ].join("");

  $("#person-form").addEventListener("submit", (event) => {
    if (event.submitter?.value === "save" && !savePersonFromForm()) event.preventDefault();
  });
}

// ---------------------------------------------------------- settings dialog

function setupSettingsDialog() {
  const dialog = $("#settings-dialog");
  const form = $("#settings-form");

  $("#open-settings").addEventListener("click", () => {
    form.elements.title.value = state.title;
    form.elements.hour12.value = state.hour12 === null ? "auto" : state.hour12 ? "12" : "24";
    dialog.showModal();
  });

  form.elements.title.addEventListener("input", () => {
    state.title = form.elements.title.value.trim();
    persist();
    renderHeader();
  });

  form.elements.hour12.addEventListener("change", () => {
    const value = form.elements.hour12.value;
    state.hour12 = value === "auto" ? null : value === "12";
    formatters.clear();
    persist();
    render();
  });

  $("#sort-team").addEventListener("click", () => {
    const now = Date.now();
    changeTeam(() => {
      state.people.sort((a, b) => tz.offsetMinutes(now, a.tz) - tz.offsetMinutes(now, b.tz));
    });
    toast("Team sorted from west to east.");
  });

  $("#export-team").addEventListener("click", () => {
    const people = state.people.map((p) => ({
      name: p.name,
      tz: p.tz,
      hours: tz.formatHours(p.start, p.end),
      days: p.days,
    }));
    const json = JSON.stringify({ title: state.title, people }, null, 2);
    download("team.json", `${json}\n`, "application/json");
  });

  $("#import-team").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const people = (data.people ?? []).map((p) => tz.normalizePerson(p, LOCAL_TZ)).filter(Boolean);
      if (people.length === 0) throw new Error("no people");
      changeTeam(() => {
        state.people = people;
        if (typeof data.title === "string") state.title = data.title;
      });
      form.elements.title.value = state.title;
      toast(`Imported ${people.length} people.`);
    } catch {
      toast("That file does not look like an exported team.");
    }
  });

  $("#reset-team").addEventListener("click", () => {
    if (!window.confirm("Replace your team with the default team? This cannot be undone.")) return;
    changeTeam(() => applyTeam(structuredClone(state.defaults)));
    form.elements.title.value = state.title;
    toast("Team reset to the default.");
  });
}

// ------------------------------------------------------------------ events

function setupEvents() {
  $("#prev-day").addEventListener("click", () => setDate(tz.addDays(state.date, -1)));
  $("#next-day").addEventListener("click", () => setDate(tz.addDays(state.date, 1)));
  $("#today").addEventListener("click", () => {
    state.selected = null;
    setDate(tz.dateInZone(Date.now(), ref().tz));
  });
  $("#date").addEventListener("change", (e) => setDate(e.target.value));
  $("#add-person").addEventListener("click", () => openPersonDialog());

  $("#share").addEventListener("click", () => {
    persist();
    const url = new URL(location.href);
    copyText(url.href, "Link copied. Anyone with it sees this team; names never reach a server.");
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
    if (button.dataset.action === "up") {
      changeTeam(() => {
        [state.people[index - 1], state.people[index]] = [state.people[index], state.people[index - 1]];
      });
      $(`button[data-action="up"][data-index="${index - 1}"]`)?.focus() ??
        $(`button[data-action="edit"][data-index="0"]`)?.focus();
    }
    if (button.dataset.action === "remove") {
      changeTeam(() => state.people.splice(index, 1));
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
    const next = {
      ArrowLeft: col - 1,
      ArrowRight: col + 1,
      Home: 0,
      End: count - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = Math.min(count - 1, Math.max(0, next));
    selectColumn(target);
    $(`.slot-button[data-col="${target}"]`)?.focus();
    $(`.slot-button[data-col="${target}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
      const fragment = tz.encodeState({ ...teamSnapshot(), at: s.start });
      copyText(`${location.origin}${location.pathname}#${fragment}`, "Link to this time copied.");
    }
    if (action === "ics") {
      const ics = tz.toIcs({
        start: s.start,
        end: s.end,
        summary: state.title || "Meeting",
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
    const saved = readSaved();
    if (saved) applyTeam(saved);
    state.source = "saved";
    state.selected = null;
    state.date = tz.dateInZone(Date.now(), ref().tz);
    persist();
    render();
  });

  window.addEventListener("hashchange", () => {
    if (location.hash.slice(1) === tz.encodeState(teamSnapshot())) return;
    loadFromLocation();
    render();
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
  // On https://<user>.github.io/<repo>/ link back to the repository.
  const match = /^([\w-]+)\.github\.io$/.exec(location.hostname);
  if (!match) return;
  const repo = location.pathname.split("/").filter(Boolean)[0] ?? `${match[1]}.github.io`;
  const link = $("#source-link");
  link.href = `https://github.com/${match[1]}/${repo}`;
  link.hidden = false;
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
