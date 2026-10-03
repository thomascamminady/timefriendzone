// Pure time-zone and team-state logic. No DOM access, so it can be unit
// tested with `node --test`. All instants are epoch milliseconds (numbers).

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Every setting the app understands. Times are minutes after local midnight,
 * days are ISO weekday digits (Monday = 1 … Sunday = 7), colours are "#rrggbb"
 * or "" for the built-in palette. Each one maps to a URL parameter; see
 * SETTINGS_PARAMS below.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  title: "",
  hour12: null, // null = follow the locale
  theme: "auto", // auto | light | dark
  lang: "", // BCP 47 locale for dates and times, "" = the browser's
  font: "geist", // geist | system | serif | mono
  from: 0, // hour (reference time) at which the timeline starts
  sort: "custom", // custom | west | east | name
  nightStart: 22 * 60,
  nightEnd: 7 * 60,
  workStart: 9 * 60, // default working hours for people without their own
  workEnd: 17 * 60,
  workDays: "12345",
  accent: "",
  workColor: "",
  awakeColor: "",
  nightColor: "",
});

export const THEMES = ["auto", "light", "dark"];
export const FONTS = ["geist", "system", "serif", "mono"];
export const SORTS = ["custom", "west", "east", "name"];

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatters = new Map();

function partsFormatter(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of `instant` as seen in `timeZone`. */
export function zonedParts(instant, timeZone) {
  const p = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(instant)) {
    p[type] = value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAY[p.weekday],
  };
}

function wallClockAsUtc(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** UTC offset of `timeZone` at `instant`, in minutes (Berlin summer = 120). */
export function offsetMinutes(instant, timeZone) {
  const whole = Math.floor(instant / 1000) * 1000;
  return Math.round((wallClockAsUtc(whole, timeZone) - whole) / MINUTE);
}

/**
 * The instant at which the wall clock in `timeZone` reads `minutes` after
 * midnight on `dateStr` (YYYY-MM-DD). Ambiguous times (DST fall-back) resolve
 * to the earlier instant; skipped times (DST spring-forward) are shifted
 * forward by the length of the gap (02:30 → 03:30).
 */
export function wallTimeToInstant(dateStr, minutes, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const local = Date.UTC(y, m - 1, d, 0, minutes);
  const candidates = [
    ...new Set(
      [local - DAY, local, local + DAY].map(
        (probe) => local - offsetMinutes(probe, timeZone) * MINUTE,
      ),
    ),
  ];
  const exact = candidates.filter((t) => wallClockAsUtc(t, timeZone) === local);
  return exact.length > 0 ? Math.min(...exact) : Math.max(...candidates);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function dateInZone(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Hourly slot start instants covering one day in `timeZone`, starting at
 * `startMinutes` after midnight on `dateStr` and running until the same wall
 * time the next day. Usually 24 slots, but 23 or 25 across a DST change.
 */
export function dayColumns(dateStr, timeZone, startMinutes = 0) {
  const start = wallTimeToInstant(dateStr, startMinutes, timeZone);
  const end = wallTimeToInstant(addDays(dateStr, 1), startMinutes, timeZone);
  const columns = [];
  for (let t = start; t < end; t += HOUR) columns.push(t);
  return columns;
}

function inRange(minutes, start, end) {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** A person's working hours and days, falling back to the team defaults. */
export function effectiveHours(person, settings = DEFAULT_SETTINGS) {
  return {
    start: person.start ?? settings.workStart,
    end: person.end ?? settings.workEnd,
    days: person.days ?? settings.workDays,
  };
}

/** How a slot starting at `instant` looks from `person`'s perspective. */
export function slotStatus(instant, person, settings = DEFAULT_SETTINGS) {
  const parts = zonedParts(instant, person.tz);
  const minutes = parts.hour * 60 + parts.minute;
  const { start, end, days } = effectiveHours(person, settings);
  const isWorkday = days.includes(String(parts.weekday));
  const previous = parts.weekday === 1 ? 7 : parts.weekday - 1;
  const wasWorkday = days.includes(String(previous));

  let working;
  if (start === end) {
    working = isWorkday; // 24h coverage
  } else if (start < end) {
    working = isWorkday && minutes >= start && minutes < end;
  } else {
    // Overnight shift, e.g. 22:00–06:00: the early-morning part belongs to
    // the shift that started on the previous day.
    working = (isWorkday && minutes >= start) || (wasWorkday && minutes < end);
  }
  const night = inRange(minutes, settings.nightStart, settings.nightEnd);
  return { parts, working, night, weekend: !isWorkday };
}

/**
 * Display order (indices into `people`). "west" puts the zones furthest
 * behind first, "east" the zones furthest ahead first; ties keep the
 * custom order. Offsets are taken at `instant`.
 */
export function sortOrder(people, mode, instant) {
  const order = people.map((_, i) => i);
  if (mode === "west" || mode === "east") {
    const sign = mode === "west" ? 1 : -1;
    const offsets = people.map((p) => offsetMinutes(instant, p.tz));
    order.sort((a, b) => sign * (offsets[a] - offsets[b]) || a - b);
  } else if (mode === "name") {
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    order.sort((a, b) => collator.compare(people[a].name, people[b].name) || a - b);
  }
  return order;
}

/** Number of people within working hours for each column. */
export function availability(columns, people, settings = DEFAULT_SETTINGS) {
  return columns.map(
    (t) => people.filter((person) => slotStatus(t, person, settings).working).length,
  );
}

/** Maximal runs of columns that share the highest availability count. */
export function bestWindows(counts) {
  const max = counts.length > 0 ? Math.max(...counts) : 0;
  const windows = [];
  if (max === 0) return { max, windows };
  let runStart = null;
  counts.forEach((count, i) => {
    if (count === max && runStart === null) runStart = i;
    if (count !== max && runStart !== null) {
      windows.push([runStart, i]);
      runStart = null;
    }
  });
  if (runStart !== null) windows.push([runStart, counts.length]);
  return { max, windows };
}

// ---------------------------------------------------------------- formatting

export function cityName(timeZone) {
  const last = timeZone.split("/").pop() ?? timeZone;
  return last.replaceAll("_", " ");
}

function hoursAndMinutes(totalMinutes) {
  const abs = Math.abs(totalMinutes);
  return [Math.floor(abs / 60), abs % 60];
}

/** "UTC", "UTC+2", "UTC−3:30" (with a real minus sign). */
export function formatOffset(minutes) {
  if (minutes === 0) return "UTC";
  const [h, m] = hoursAndMinutes(minutes);
  const sign = minutes > 0 ? "+" : "−";
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** Relative difference between two zones: "same time", "+6h", "−4h30". */
export function formatDiff(minutes) {
  if (minutes === 0) return "same time";
  const [h, m] = hoursAndMinutes(minutes);
  const sign = minutes > 0 ? "+" : "−";
  return `${sign}${h}h${m ? String(m).padStart(2, "0") : ""}`;
}

/** 540 → "9", 510 → "8:30". */
export function formatHM(minutes) {
  const [h, m] = hoursAndMinutes(minutes);
  return m ? `${h}:${String(m).padStart(2, "0")}` : `${h}`;
}

/** 540 → "09:00" (for <input type="time">). */
export function toTimeInput(minutes) {
  const [h, m] = hoursAndMinutes(minutes % (24 * 60));
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fromTimeInput(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Relative position of a zone: "same time", "3h30 ahead", "6h behind". */
export function formatLead(minutes) {
  if (minutes === 0) return "same time";
  const [h, m] = hoursAndMinutes(minutes);
  const amount = `${h}h${m ? String(m).padStart(2, "0") : ""}`;
  return `${amount} ${minutes > 0 ? "ahead" : "behind"}`;
}

/** "9-17" or "08:30-17:15" → { start, end } in minutes, or null. */
export function parseHours(text) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(
    text ?? "",
  );
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2] ?? 0);
  const end = Number(match[3]) * 60 + Number(match[4] ?? 0);
  if (start > 24 * 60 || end > 24 * 60) return null;
  return { start: start % (24 * 60), end: end % (24 * 60) };
}

export function formatHours(start, end) {
  return `${formatHM(start)}-${formatHM(end)}`;
}

export function normalizeDays(days) {
  const digits = [...new Set(String(days ?? "").replace(/[^1-7]/g, ""))].sort();
  return digits.join("");
}

// ----------------------------------------------------------------- colours

/** "#4338CA", "4338ca" or "43c" → "#4338ca"; anything else → "". */
export function parseColor(text) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text ?? "").trim());
  if (!match) return "";
  const hex = match[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Near-black or white, whichever is more readable on `background`. */
export function readableTextColor(background) {
  const dark = "#1c1917";
  const light = "#ffffff";
  return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light;
}

// ---------------------------------------------------------------- settings

function parseHour(text) {
  const match = /^(\d{1,2})(?::00)?$/.exec(String(text ?? "").trim());
  const hour = match ? Number(match[1]) : NaN;
  return hour >= 0 && hour <= 23 ? hour : null;
}

function isSupportedLocale(lang) {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([lang]).length > 0;
  } catch {
    return false;
  }
}

/**
 * URL parameter ↔ setting. `parse` turns the text into a partial settings
 * object (or null when invalid); `format` turns settings back into text.
 */
export const SETTINGS_PARAMS = {
  title: {
    parse: (v) => ({ title: v.trim().slice(0, 120) }),
    format: (s) => s.title,
  },
  h: {
    parse: (v) => (v === "12" ? { hour12: true } : v === "24" ? { hour12: false } : v === "auto" ? { hour12: null } : null),
    format: (s) => (s.hour12 === null ? "auto" : s.hour12 ? "12" : "24"),
  },
  theme: {
    parse: (v) => (THEMES.includes(v) ? { theme: v } : null),
    format: (s) => s.theme,
  },
  lang: {
    parse: (v) => (v === "" || isSupportedLocale(v) ? { lang: v } : null),
    format: (s) => s.lang,
  },
  font: {
    parse: (v) => (FONTS.includes(v) ? { font: v } : null),
    format: (s) => s.font,
  },
  sort: {
    parse: (v) => (SORTS.includes(v) ? { sort: v } : null),
    format: (s) => s.sort,
  },
  from: {
    parse: (v) => (parseHour(v) === null ? null : { from: parseHour(v) }),
    format: (s) => String(s.from),
  },
  night: {
    parse: (v) => {
      const range = parseHours(v);
      return range && { nightStart: range.start, nightEnd: range.end };
    },
    format: (s) => formatHours(s.nightStart, s.nightEnd),
  },
  hours: {
    parse: (v) => {
      const range = parseHours(v);
      return range && { workStart: range.start, workEnd: range.end };
    },
    format: (s) => formatHours(s.workStart, s.workEnd),
  },
  days: {
    parse: (v) => ({ workDays: v === "0" ? "" : normalizeDays(v) }),
    format: (s) => s.workDays || "0",
  },
  "c-accent": { parse: (v) => ({ accent: parseColor(v) }), format: (s) => s.accent.slice(1) },
  "c-work": { parse: (v) => ({ workColor: parseColor(v) }), format: (s) => s.workColor.slice(1) },
  "c-awake": { parse: (v) => ({ awakeColor: parseColor(v) }), format: (s) => s.awakeColor.slice(1) },
  "c-night": { parse: (v) => ({ nightColor: parseColor(v) }), format: (s) => s.nightColor.slice(1) },
};

/** Apply `params` ({ name: text } or [name, text] pairs) on top of `base`. */
export function parseSettings(params, base = DEFAULT_SETTINGS) {
  const settings = { ...base };
  const entries = Array.isArray(params) ? params : Object.entries(params ?? {});
  for (const [key, value] of entries) {
    const spec = SETTINGS_PARAMS[key];
    if (!spec || value === null || value === undefined) continue;
    const parsed = spec.parse(String(value));
    if (parsed) Object.assign(settings, parsed);
  }
  return settings;
}

/**
 * [name, text] pairs for every setting that differs from any of `bases`, so
 * a link reproduces the same view whatever defaults the host provides.
 */
export function settingsToParams(settings, bases = [DEFAULT_SETTINGS]) {
  const pairs = [];
  for (const [key, spec] of Object.entries(SETTINGS_PARAMS)) {
    const value = spec.format(settings);
    if (bases.some((base) => spec.format(base) !== value)) pairs.push([key, value]);
  }
  return pairs;
}

// ----------------------------------------------------------------- people

/**
 * Validate a person from config, a link or an import. `tz: "auto"` resolves
 * to `localTz`. Hours and days are left undefined when not given, meaning
 * "use the team default". Returns null when unusable.
 */
export function normalizePerson(raw, localTz = "UTC") {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim().slice(0, 80);
  const timeZone = raw.tz === "auto" ? localTz : String(raw.tz ?? "");
  if (!name || !isValidTimeZone(timeZone)) return null;

  const person = { name, tz: timeZone };
  const hours =
    typeof raw.hours === "string"
      ? parseHours(raw.hours)
      : Number.isFinite(raw.start) && Number.isFinite(raw.end)
        ? { start: raw.start, end: raw.end }
        : null;
  if (hours) Object.assign(person, hours);
  if (typeof raw.days === "string") person.days = normalizeDays(raw.days);
  return person;
}

/** The JSON shape used by config.json and team export. */
export function personToJson(person) {
  const json = { name: person.name, tz: person.tz };
  if (person.start !== undefined) json.hours = formatHours(person.start, person.end);
  if (person.days !== undefined) json.days = person.days;
  return json;
}

// -------------------------------------------------------------- URL state

// Keep slashes, colons and spaces readable in the link.
function encodePart(text) {
  return encodeURIComponent(text)
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":")
    .replace(/%20/g, "+");
}

function decodePart(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/**
 * Serialise everything into a URL fragment (without "#"). The fragment is
 * never sent to the web server, so colleague names stay with the link holder.
 *
 *   title=Platform+Team&night=23-6&c-accent=0f766e&p=Ada,Europe/London&p=Noa,Asia/Jerusalem,,71234
 *
 * `bases` are the defaults the reader may already have (see settingsToParams).
 */
export function encodeState({ settings = DEFAULT_SETTINGS, people, at = null }, bases) {
  const parts = settingsToParams(settings, bases).map(
    ([key, value]) => `${key}=${encodePart(value)}`,
  );
  for (const person of people) {
    const fields = [person.name, person.tz];
    const hours = person.start === undefined ? "" : formatHours(person.start, person.end);
    if (person.days !== undefined) fields.push(hours, person.days || "0");
    else if (hours) fields.push(hours);
    parts.push(`p=${fields.map(encodePart).join(",")}`);
  }
  if (Number.isFinite(at)) parts.push(`at=${new Date(at).toISOString().slice(0, 16)}Z`);
  return parts.join("&");
}

/**
 * Inverse of encodeState. Settings missing from the fragment come from
 * `base`. `people` is null when the fragment lists nobody.
 */
export function decodeState(fragment, localTz = "UTC", base = DEFAULT_SETTINGS) {
  const params = [];
  let people = null;
  let at = null;
  const text = (fragment ?? "").replace(/^#/, "");
  for (const pair of text ? text.split("&") : []) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === "p") {
      const [name, timeZone, hours, days] = value.split(",").map(decodePart);
      if (!timeZone) continue;
      const person = normalizePerson(
        {
          name,
          tz: timeZone,
          hours: hours || undefined,
          days: days === undefined ? undefined : days === "0" ? "" : days,
        },
        localTz,
      );
      if (person) (people ??= []).push(person);
    } else if (key === "at") {
      const instant = Date.parse(decodePart(value));
      if (Number.isFinite(instant)) at = instant;
    } else {
      params.push([key, decodePart(value)]);
    }
  }
  return { settings: parseSettings(params, base), people, at };
}

// ------------------------------------------------------------ zone lookup

// Common places whose names are not part of an IANA identifier.
export const CITY_ALIASES = {
  "san francisco": "America/Los_Angeles",
  "seattle": "America/Los_Angeles",
  "silicon valley": "America/Los_Angeles",
  "portland": "America/Los_Angeles",
  "boston": "America/New_York",
  "washington": "America/New_York",
  "atlanta": "America/New_York",
  "miami": "America/New_York",
  "austin": "America/Chicago",
  "dallas": "America/Chicago",
  "houston": "America/Chicago",
  "salt lake city": "America/Denver",
  "montreal": "America/Toronto",
  "ottawa": "America/Toronto",
  "rio de janeiro": "America/Sao_Paulo",
  "munich": "Europe/Berlin",
  "hamburg": "Europe/Berlin",
  "frankfurt": "Europe/Berlin",
  "cologne": "Europe/Berlin",
  "geneva": "Europe/Zurich",
  "barcelona": "Europe/Madrid",
  "milan": "Europe/Rome",
  "edinburgh": "Europe/London",
  "manchester": "Europe/London",
  "kiev": "Europe/Kyiv",
  "st petersburg": "Europe/Moscow",
  "tel aviv": "Asia/Jerusalem",
  "abu dhabi": "Asia/Dubai",
  "mumbai": "Asia/Kolkata",
  "bombay": "Asia/Kolkata",
  "delhi": "Asia/Kolkata",
  "new delhi": "Asia/Kolkata",
  "bangalore": "Asia/Kolkata",
  "bengaluru": "Asia/Kolkata",
  "chennai": "Asia/Kolkata",
  "hyderabad": "Asia/Kolkata",
  "beijing": "Asia/Shanghai",
  "shenzhen": "Asia/Shanghai",
  "hanoi": "Asia/Bangkok",
  "osaka": "Asia/Tokyo",
  "canberra": "Australia/Sydney",
  "wellington": "Pacific/Auckland",
  "utc": "UTC",
  "gmt": "UTC",
};

/** Resolve user input ("berlin", "Asia/Tokyo", "san francisco") to a zone. */
export function resolveTimeZone(input, zones) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const exact = zones.find((zone) => zone.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  if (isValidTimeZone(text)) return text;
  const key = text.toLowerCase().replace(/[_.]/g, " ").replace(/\s+/g, " ");
  if (CITY_ALIASES[key]) return CITY_ALIASES[key];
  return zones.find((zone) => cityName(zone).toLowerCase() === key) ?? null;
}

// ---------------------------------------------------------------- iCalendar

function icsStamp(instant) {
  return new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** A minimal RFC 5545 calendar with one event. */
export function toIcs({ start, end, summary, description, uid, now = Date.now() }) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TimeFriendZone//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
