import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as tz from "../js/tz.js";

const person = (overrides = {}) =>
  tz.normalizePerson({ name: "Test", tz: "Europe/Berlin", ...overrides });

describe("offsets", () => {
  test("summer and winter offsets", () => {
    assert.equal(tz.offsetMinutes(Date.UTC(2026, 6, 1), "Europe/Berlin"), 120);
    assert.equal(tz.offsetMinutes(Date.UTC(2026, 0, 1), "Europe/Berlin"), 60);
    assert.equal(tz.offsetMinutes(Date.UTC(2026, 0, 1), "Asia/Kolkata"), 330);
    assert.equal(tz.offsetMinutes(Date.UTC(2026, 0, 1), "Asia/Kathmandu"), 345);
    assert.equal(tz.offsetMinutes(Date.UTC(2026, 0, 1), "America/St_Johns"), -210);
  });

  test("formatting", () => {
    assert.equal(tz.formatOffset(0), "UTC");
    assert.equal(tz.formatOffset(330), "UTC+5:30");
    assert.equal(tz.formatOffset(-180), "UTC−3");
    assert.equal(tz.formatDiff(0), "same time");
    assert.equal(tz.formatDiff(-270), "−4h30");
    assert.equal(tz.formatDiff(360), "+6h");
  });
});

describe("wallTimeToInstant", () => {
  test("regular time", () => {
    assert.equal(
      tz.wallTimeToInstant("2026-07-01", 9 * 60, "Europe/Berlin"),
      Date.UTC(2026, 6, 1, 7),
    );
  });

  test("skipped time shifts forward by the gap", () => {
    // Berlin jumps 02:00 → 03:00 on 2026-03-29, so 02:30 becomes 03:30 CEST.
    assert.equal(
      tz.wallTimeToInstant("2026-03-29", 2 * 60 + 30, "Europe/Berlin"),
      Date.UTC(2026, 2, 29, 1, 30),
    );
  });

  test("ambiguous time resolves to the earlier instant", () => {
    // Berlin repeats 02:00–03:00 on 2026-10-25.
    assert.equal(
      tz.wallTimeToInstant("2026-10-25", 2 * 60 + 30, "Europe/Berlin"),
      Date.UTC(2026, 9, 25, 0, 30),
    );
  });

  test("midnight that does not exist", () => {
    // Santiago skips 00:00 → 01:00 on 2026-09-06.
    const t = tz.wallTimeToInstant("2026-09-06", 0, "America/Santiago");
    const parts = tz.zonedParts(t, "America/Santiago");
    assert.deepEqual([parts.day, parts.hour], [6, 1]);
  });
});

describe("dayColumns", () => {
  test("normal day has 24 hours", () => {
    assert.equal(tz.dayColumns("2026-07-01", "Europe/Berlin").length, 24);
  });

  test("DST days have 23 and 25 hours", () => {
    assert.equal(tz.dayColumns("2026-03-29", "Europe/Berlin").length, 23);
    assert.equal(tz.dayColumns("2026-10-25", "Europe/Berlin").length, 25);
  });

  test("first column is local midnight", () => {
    const [first] = tz.dayColumns("2026-07-01", "Asia/Tokyo");
    assert.equal(tz.dateInZone(first, "Asia/Tokyo"), "2026-07-01");
    assert.equal(tz.zonedParts(first, "Asia/Tokyo").hour, 0);
  });
});

describe("slotStatus", () => {
  // Wednesday 2026-07-01.
  test("working hours on a workday", () => {
    const p = person();
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 1, 7), p).working, true); // 09:00
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 1, 15), p).working, false); // 17:00
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 1, 6), p).working, false); // 08:00
  });

  test("weekend is not working", () => {
    const status = tz.slotStatus(Date.UTC(2026, 6, 4, 10), person()); // Saturday
    assert.equal(status.working, false);
    assert.equal(status.weekend, true);
  });

  test("custom work week (Sunday to Thursday)", () => {
    const p = person({ tz: "Asia/Jerusalem", days: "71234" });
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 5, 8), p).working, true); // Sunday 11:00
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 3, 8), p).working, false); // Friday
  });

  test("overnight shift belongs to the previous workday", () => {
    const p = person({ hours: "22-6" });
    // Friday 23:00 and Saturday 03:00 Berlin are both part of Friday's shift.
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 3, 21), p).working, true);
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 4, 1), p).working, true);
    // Saturday 23:00 is not.
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 4, 21), p).working, false);
  });

  test("night flag", () => {
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 1, 1), person()).night, true);
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 1, 10), person()).night, false);
  });
});

describe("availability", () => {
  test("best windows", () => {
    assert.deepEqual(tz.bestWindows([0, 2, 2, 1, 2, 0]), {
      max: 2,
      windows: [
        [1, 3],
        [4, 5],
      ],
    });
    assert.deepEqual(tz.bestWindows([0, 0]), { max: 0, windows: [] });
    assert.deepEqual(tz.bestWindows([1, 1]).windows, [[0, 2]]);
  });

  test("Berlin and New York overlap 15:00–17:00 Berlin time", () => {
    const people = [person(), person({ tz: "America/New_York" })];
    const columns = tz.dayColumns("2026-07-01", "Europe/Berlin");
    const { max, windows } = tz.bestWindows(tz.availability(columns, people));
    assert.equal(max, 2);
    assert.deepEqual(windows, [[15, 17]]);
  });
});

describe("parsing", () => {
  test("hours", () => {
    assert.deepEqual(tz.parseHours("9-17"), { start: 540, end: 1020 });
    assert.deepEqual(tz.parseHours("08:30 - 17:15"), { start: 510, end: 1035 });
    assert.deepEqual(tz.parseHours("22-6"), { start: 1320, end: 360 });
    assert.equal(tz.parseHours("25-3"), null);
    assert.equal(tz.parseHours("nine to five"), null);
  });

  test("time inputs", () => {
    assert.equal(tz.toTimeInput(510), "08:30");
    assert.equal(tz.fromTimeInput("08:30"), 510);
    assert.equal(tz.fromTimeInput(""), null);
  });

  test("normalizePerson", () => {
    assert.equal(tz.normalizePerson({ name: "", tz: "UTC" }), null);
    assert.equal(tz.normalizePerson({ name: "X", tz: "Mars/Olympus" }), null);
    assert.equal(tz.normalizePerson({ name: "Me", tz: "auto" }, "Asia/Tokyo").tz, "Asia/Tokyo");
    assert.equal(tz.normalizePerson({ name: "X", tz: "UTC", days: "5,1,1,9" }).days, "15");
  });

  test("resolveTimeZone", () => {
    const zones = ["Europe/Berlin", "America/New_York", "America/Los_Angeles", "UTC"];
    assert.equal(tz.resolveTimeZone("berlin", zones), "Europe/Berlin");
    assert.equal(tz.resolveTimeZone("New York", zones), "America/New_York");
    assert.equal(tz.resolveTimeZone("america/new_york", zones), "America/New_York");
    assert.equal(tz.resolveTimeZone("San Francisco", zones), "America/Los_Angeles");
    assert.equal(tz.resolveTimeZone("Atlantis", zones), null);
  });
});

describe("URL state", () => {
  test("round trip", () => {
    const state = {
      settings: tz.parseSettings({ title: "Team Rocket & Friends", h: "12" }),
      people: [
        person({ name: "Zoë, the lead" }),
        person({ name: "Kenji", tz: "Asia/Tokyo", hours: "10-19" }),
        person({ name: "Noa", tz: "Asia/Jerusalem", days: "71234" }),
        person({ name: "Bot", tz: "UTC", days: "" }),
      ],
      at: Date.UTC(2026, 9, 7, 13),
    };
    const fragment = tz.encodeState(state);
    assert.deepEqual(tz.decodeState(`#${fragment}`), state);
  });

  test("defaults are omitted and links stay readable", () => {
    const fragment = tz.encodeState({ people: [person({ name: "Ada Lovelace" })] });
    assert.equal(fragment, "p=Ada+Lovelace,Europe/Berlin");
  });

  test("custom days without custom hours", () => {
    const fragment = tz.encodeState({ people: [person({ name: "Noa", days: "71234" })] });
    assert.equal(fragment, "p=Noa,Europe/Berlin,,12347");
  });

  test("invalid entries are skipped", () => {
    const state = tz.decodeState("#p=Ok,UTC&p=Bad,Nowhere/Land&p=%E0%A4%A&junk");
    assert.deepEqual(
      state.people.map((p) => p.name),
      ["Ok"],
    );
  });

  test("empty fragment", () => {
    const state = tz.decodeState("");
    assert.equal(state.people, null);
    assert.deepEqual(state.settings, tz.DEFAULT_SETTINGS);
  });
});

describe("settings", () => {
  test("every setting round-trips through the URL", () => {
    const settings = tz.parseSettings({
      title: "Ops",
      h: "24",
      theme: "dark",
      lang: "de-DE",
      font: "mono",
      from: "6",
      night: "23-6:30",
      hours: "8:30-16:30",
      days: "71234",
      "c-accent": "#0F766E",
      "c-work": "abc",
      "c-awake": "ffffff",
      "c-night": "222222",
    });
    assert.deepEqual(settings, {
      title: "Ops",
      hour12: false,
      theme: "dark",
      lang: "de-DE",
      font: "mono",
      from: 6,
      nightStart: 23 * 60,
      nightEnd: 6 * 60 + 30,
      workStart: 8 * 60 + 30,
      workEnd: 16 * 60 + 30,
      workDays: "12347",
      accent: "#0f766e",
      workColor: "#aabbcc",
      awakeColor: "#ffffff",
      nightColor: "#222222",
    });
    const fragment = tz.encodeState({ settings, people: [] });
    assert.deepEqual(tz.decodeState(fragment).settings, settings);
  });

  test("invalid values are ignored", () => {
    const settings = tz.parseSettings({
      theme: "neon",
      font: "comic",
      from: "25",
      night: "late",
      lang: "not a locale!!",
      "c-accent": "red",
      unknown: "x",
    });
    assert.deepEqual(settings, tz.DEFAULT_SETTINGS);
  });

  test("link settings override host defaults, and host defaults fill gaps", () => {
    const host = tz.parseSettings({ title: "Host", "c-accent": "112233" });
    const state = tz.decodeState("title=Link&p=A,UTC", "UTC", host);
    assert.equal(state.settings.title, "Link");
    assert.equal(state.settings.accent, "#112233");
  });

  test("a setting reset to the built-in default still overrides the host", () => {
    const host = tz.parseSettings({ "c-accent": "112233" });
    const fragment = tz.encodeState({ settings: tz.DEFAULT_SETTINGS, people: [] }, [
      tz.DEFAULT_SETTINGS,
      host,
    ]);
    assert.equal(tz.decodeState(fragment, "UTC", host).settings.accent, "");
  });

  test("configurable night and team default hours", () => {
    const settings = tz.parseSettings({ night: "0-6", hours: "7-15", days: "123456" });
    const p = person();
    // Saturday 2026-07-04 10:00 Berlin: working with a six-day week.
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 4, 8), p, settings).working, true);
    // 23:00 is not night when night is 0–6.
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 1, 21), p, settings).night, false);
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 1, 2), p, settings).night, true);
    // Personal hours beat the team default.
    const own = person({ hours: "12-20" });
    assert.equal(tz.slotStatus(Date.UTC(2026, 6, 1, 5), own, settings).working, false);
  });

  test("timeline can start at a later hour", () => {
    const columns = tz.dayColumns("2026-07-01", "Europe/Berlin", 6 * 60);
    assert.equal(columns.length, 24);
    assert.equal(tz.zonedParts(columns[0], "Europe/Berlin").hour, 6);
    assert.equal(tz.zonedParts(columns[23], "Europe/Berlin").day, 2);
  });

  test("readable text colour", () => {
    assert.equal(tz.readableTextColor("#ffffff"), "#1c1917");
    assert.equal(tz.readableTextColor("#1e1b4b"), "#ffffff");
    assert.ok(tz.contrastRatio("#000000", "#ffffff") > 20);
  });
});

test("iCalendar export", () => {
  const ics = tz.toIcs({
    start: Date.UTC(2026, 9, 7, 13),
    end: Date.UTC(2026, 9, 7, 14),
    summary: "Sync; weekly",
    description: "Line 1\nLine 2",
    uid: "abc@test",
    now: Date.UTC(2026, 9, 1),
  });
  assert.match(ics, /DTSTART:20261007T130000Z\r\n/);
  assert.match(ics, /SUMMARY:Sync\\; weekly/);
  assert.match(ics, /DESCRIPTION:Line 1\\nLine 2/);
});
