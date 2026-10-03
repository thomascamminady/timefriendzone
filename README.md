# TimeFriendZone

See your colleagues' local times and working hours side by side, and find a meeting slot that works for everyone. Inspired by worldtimebuddy, but built around **people** rather than cities, and free software you can host yourself on GitHub Pages.

- **People first.** Each row is a colleague with their own working hours and working days (Sun–Thu weeks and night shifts are supported). Many people can share a city.
- **Overlap at a glance.** The top row counts who is working in each hour, and the app names the best windows ("Everyone is working 15:00–17:00").
- **Correct across DST.** Uses the browser's IANA time-zone database. Days with 23 or 25 hours, half-hour and 45-minute offsets (India, Nepal, Newfoundland) are handled properly.
- **Shareable without a server.** The whole team lives in the URL fragment (`#…`), which browsers never send to the web server, so names stay private to whoever has the link. Your own team is also kept in local storage.
- **Propose a time.** Select an hour, then copy a plain-text summary of everyone's local time, copy a link to that exact time, or download an `.ics` calendar invite.
- **Accessible.** It uses a semantic table with row and column headers, and you can move between hours with the arrow keys. States are never shown by colour alone (there are text labels, plus stripes for days off). It has visible focus outlines, light and dark themes, support for forced-colours mode, and works on phones.
- **Simple.** Plain HTML, CSS and JavaScript modules, with no build step, no dependencies, no tracking and no cookies.

## Parameterising

There are three layers. Each one overrides the one below it:

1. **Link**: `index.html#title=Platform+Team&p=Ada,Europe/London&p=Kenji,Asia/Tokyo,10-19&p=Noa,Asia/Jerusalem,9-17,71234&h=24`
   - `p=name,zone[,hours[,days]]` is repeated once per person. `hours` looks like `9-17` or `8:30-17:15`, and `days` uses ISO weekday digits (`1` = Monday … `7` = Sunday). The defaults are `9-17` and `12345`.
   - `title=` sets the page title, `h=12` or `h=24` sets the clock format, and `at=2026-10-07T13:00Z` pre-selects a time.
2. **This browser**: whatever you last edited is saved in local storage. If you open a link to someone else's team, you can choose to keep it or go back to your own.
3. **`config.json`**: the default team for first-time visitors. Edit it in your fork to give your whole team a ready-made page:

   ```json
   {
     "title": "Platform Team",
     "hour12": null,
     "people": [
       { "name": "Me", "tz": "auto" },
       { "name": "Kenji", "tz": "Asia/Tokyo", "hours": "10-19" },
       { "name": "Noa", "tz": "Asia/Jerusalem", "days": "71234" }
     ]
   }
   ```

   `"tz": "auto"` means the visitor's own time zone.

## Deploying your own copy

1. Fork or push this repository to GitHub.
2. Go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow in `.github/workflows/pages.yml` runs the tests and then publishes the site to `https://<user>.github.io/<repo>/`.

## Developing

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node --test tests/            # unit tests for js/tz.js (Node 20+)
```

All time-zone logic is in `js/tz.js`, which has no DOM dependencies and is covered by tests. The UI is in `js/app.js`.

## Licence

[GPL-3.0-or-later](LICENSE). You are free to use, study, share and improve it.
