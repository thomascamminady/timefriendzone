// Pure time-zone and team-state logic. No DOM access, so it can be unit
// tested with `node --test`. All instants are epoch milliseconds (numbers).

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const DEFAULT_DAYS = "12345"; // ISO weekdays: Monday = 1 … Sunday = 7
export const DEFAULT_START = 9 * 60; // minutes after local midnight
export const DEFAULT_END = 17 * 60;
export const NIGHT_START = 22; // local hours considered "asleep"
export const NIGHT_END = 7;

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
 * Hourly slot start instants covering the local day `dateStr` in `timeZone`.
 * Usually 24 slots, but 23 or 25 on DST transition days.
 */
export function dayColumns(dateStr, timeZone) {
  const start = wallTimeToInstant(dateStr, 0, timeZone);
  const end = wallTimeToInstant(addDays(dateStr, 1), 0, timeZone);
  const columns = [];
  for (let t = start; t < end; t += HOUR) columns.push(t);
  return columns;
}

/** How a slot starting at `instant` looks from `person`'s perspective. */
export function slotStatus(instant, person) {
  const parts = zonedParts(instant, person.tz);
  const minutes = parts.hour * 60 + parts.minute;
  const days = person.days ?? DEFAULT_DAYS;
  const isWorkday = days.includes(String(parts.weekday));
  const previous = parts.weekday === 1 ? 7 : parts.weekday - 1;
  const wasWorkday = days.includes(String(previous));
  const { start, end } = person;

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
  const night = parts.hour >= NIGHT_START || parts.hour < NIGHT_END;
  return { parts, working, night, weekend: !isWorkday };
}

/** Number of people within working hours for each column. */
export function availability(columns, people) {
  return columns.map(
    (t) => people.filter((person) => slotStatus(t, person).working).length,
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

// ----------------------------------------------------------------- people

/**
 * Validate and fill defaults for a person from config, a link or storage.
 * `tz: "auto"` resolves to `localTz`. Returns null when unusable.
 */
export function normalizePerson(raw, localTz = "UTC") {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim().slice(0, 80);
  const timeZone = raw.tz === "auto" || !raw.tz ? localTz : String(raw.tz);
  if (!name || !isValidTimeZone(timeZone)) return null;

  let hours = { start: DEFAULT_START, end: DEFAULT_END };
  if (typeof raw.hours === "string") {
    hours = parseHours(raw.hours) ?? hours;
  } else if (Number.isFinite(raw.start) && Number.isFinite(raw.end)) {
    hours = { start: raw.start, end: raw.end };
  }
  const days = raw.days === undefined ? DEFAULT_DAYS : normalizeDays(raw.days);
  return { name, tz: timeZone, start: hours.start, end: hours.end, days };
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
 * Serialise state into a URL fragment (without "#"). The fragment is never
 * sent to the web server, so colleague names stay private to the link holder.
 *
 *   title=Team+Rocket&p=Ada,Europe/London&p=Kenji,Asia/Tokyo,10-19,12345&h=24
 */
export function encodeState({ title, people, hour12, at }) {
  const parts = [];
  if (title) parts.push(`title=${encodePart(title)}`);
  for (const person of people) {
    const fields = [person.name, person.tz];
    const customDays = person.days !== DEFAULT_DAYS;
    const customHours = person.start !== DEFAULT_START || person.end !== DEFAULT_END;
    if (customHours || customDays) fields.push(formatHours(person.start, person.end));
    if (customDays) fields.push(person.days || "0");
    parts.push(`p=${fields.map(encodePart).join(",")}`);
  }
  if (hour12 === true) parts.push("h=12");
  if (hour12 === false) parts.push("h=24");
  if (Number.isFinite(at)) parts.push(`at=${new Date(at).toISOString().slice(0, 16)}Z`);
  return parts.join("&");
}

/** Inverse of encodeState. `people` is null when the fragment has none. */
export function decodeState(fragment, localTz = "UTC") {
  const result = { title: null, people: null, hour12: null, at: null };
  const text = (fragment ?? "").replace(/^#/, "");
  if (!text) return result;
  for (const pair of text.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === "title") {
      result.title = decodePart(value).slice(0, 120);
    } else if (key === "p") {
      const [name, timeZone, hours, days] = value.split(",").map(decodePart);
      if (!timeZone) continue;
      const person = normalizePerson(
        { name, tz: timeZone, hours, days: days === "0" ? "" : days },
        localTz,
      );
      if (person) (result.people ??= []).push(person);
    } else if (key === "h") {
      result.hour12 = value === "12" ? true : value === "24" ? false : null;
    } else if (key === "at") {
      const at = Date.parse(decodePart(value));
      if (Number.isFinite(at)) result.at = at;
    }
  }
  return result;
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
