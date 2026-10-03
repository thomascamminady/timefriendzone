// Exhaustive checks against an independent oracle (Intl's "longOffset" names)
// across every IANA zone the runtime knows, plus large-team round trips.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as tz from "../js/tz.js";

const ZONES = Intl.supportedValuesOf("timeZone");
const YEAR = 2026;

const oracleFormatters = new Map();
function oracleOffset(instant, timeZone) {
  let f = oracleFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    oracleFormatters.set(timeZone, f);
  }
  const name = f.formatToParts(instant).find((p) => p.type === "timeZoneName").value;
  const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name);
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function* daysOfYear() {
  for (let d = 0; d < 365; d++) yield tz.addDays(`${YEAR}-01-01`, d);
}

describe(`all ${ZONES.length} zones, every day of ${YEAR}`, () => {
  test("offsets agree with Intl longOffset at every local noon and midnight", () => {
    let checks = 0;
    for (const zone of ZONES) {
      for (const date of daysOfYear()) {
        for (const minutes of [0, 12 * 60]) {
          const t = tz.wallTimeToInstant(date, minutes, zone);
          assert.equal(tz.offsetMinutes(t, zone), oracleOffset(t, zone), `${zone} ${date}`);
          checks++;
        }
      }
    }
    assert.ok(checks > 200_000);
  });

  test("day columns are contiguous hours covering exactly one local day", () => {
    for (const zone of ZONES) {
      for (const date of daysOfYear()) {
        const cols = tz.dayColumns(date, zone);
        // 22 and 26 hours happen too: Antarctica/Troll moves its clocks by two hours.
        assert.ok(cols.length >= 22 && cols.length <= 26, `${zone} ${date}: ${cols.length}`);
        assert.equal(tz.dateInZone(cols[0], zone), date, `${zone} ${date} start`);
        assert.equal(tz.zonedParts(cols[0], zone).hour <= 1, true, `${zone} ${date} hour`);
        const next = tz.wallTimeToInstant(tz.addDays(date, 1), 0, zone);
        assert.ok(cols.at(-1) < next && cols.at(-1) + tz.HOUR >= next, `${zone} ${date} end`);
        for (let i = 1; i < cols.length; i++) assert.equal(cols[i] - cols[i - 1], tz.HOUR);
      }
    }
  });

  test("wall time round trip for every hour on DST-change days", () => {
    for (const zone of ZONES) {
      for (const date of daysOfYear()) {
        const cols = tz.dayColumns(date, zone);
        if (cols.length === 24) continue;
        for (let h = 0; h < 24; h++) {
          const t = tz.wallTimeToInstant(date, h * 60, zone);
          const p = tz.zonedParts(t, zone);
          // Either the exact wall time, or (inside a DST gap) up to two hours
          // after it, possibly on the next day.
          const [y, m, d] = date.split("-").map(Number);
          const shift = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Date.UTC(y, m - 1, d, h);
          assert.ok(shift >= 0 && shift <= 2 * tz.HOUR, `${zone} ${date} ${h}: ${shift}`);
        }
      }
    }
  });
});

describe("a large team", () => {
  const names = [
    "Ada", "Zoë, the lead", "José & María", "Søren", "Łukasz", "Nguyễn Văn An",
    "محمد", "李雷", "さくら", "Олег", "O'Brien", "100% Tom", "A+B=C", "#hash", "Emoji 🚀",
  ];
  const team = ZONES.map((zone, i) =>
    tz.normalizePerson({
      name: `${names[i % names.length]} ${i}`,
      tz: zone,
      ...(i % 3 === 0 ? { hours: "8:30-17:15" } : {}),
      ...(i % 7 === 0 ? { days: "71234" } : {}),
      ...(i % 11 === 0 ? { hours: "22-6" } : {}),
    }),
  );

  test("every zone is a valid person", () => {
    assert.equal(team.filter(Boolean).length, ZONES.length);
  });

  test(`URL round trip with ${ZONES.length} people and odd names`, () => {
    const state = { settings: tz.parseSettings({ night: "23-6", "c-accent": "0f766e" }), people: team, at: null };
    const fragment = tz.encodeState(state);
    assert.deepEqual(tz.decodeState(fragment), state);
    // Links must not contain characters that break when pasted.
    assert.doesNotMatch(fragment, /[\s#"<>`]/);
  });

  test("availability and best windows over a whole year stay consistent", () => {
    const people = team.slice(0, 60);
    for (const date of daysOfYear()) {
      const cols = tz.dayColumns(date, "Europe/Berlin");
      const counts = tz.availability(cols, people);
      const { max, windows } = tz.bestWindows(counts);
      assert.equal(max, Math.max(...counts));
      for (const [from, to] of windows) {
        for (let i = from; i < to; i++) assert.equal(counts[i], max);
      }
      assert.equal(
        windows.reduce((n, [from, to]) => n + to - from, 0),
        counts.filter((c) => c === max && max > 0).length,
      );
    }
  });
});
