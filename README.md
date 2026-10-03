# TimeFriendZone

See your colleagues' local times and working hours side by side, and find a meeting slot that works for everyone. **One link configures everything**: the team, the hours, the colours, and the language.

It is a free-software alternative inspired by [World Time Buddy](https://www.worldtimebuddy.com/). It is built around **people** rather than cities, and you can host it yourself on GitHub Pages.

- **People first.** Each row is a colleague with their own working hours and working days. Sunday–Thursday weeks, six-day weeks and night shifts all work.
- **Overlap at a glance.** The top row counts who is working in each hour. The app then names the best windows, for example "Everyone is working 15:00–17:00".
- **Correct across DST.** It uses the browser's IANA time-zone database. Days with 22–26 hours, as well as half-hour and 45-minute offsets, are handled. The tests check every zone on every day of the year against an independent source.
- **Propose a time.** Select an hour, then copy a plain-text summary or a link to that exact time, or download an `.ics` calendar invite.
- **Accessible.** It uses a semantic table and supports arrow-key navigation. States have text labels and patterns, not just colour. It shows visible focus, adjusts text colour automatically for readability, and supports light/dark/forced-colours modes. It works on phones.
- **Simple.** Plain HTML, CSS and JavaScript modules. There is no build step and nothing to install.

## Privacy

- No accounts, cookies, analytics, trackers, ads or third-party requests. Fonts are self-hosted, and the page loads nothing from other servers.
- Your team and settings live in the URL **fragment** (the part after `#`). Browsers never send the fragment to the web server, so colleague names don't appear in any server log.
- Your own team is also kept in the browser's `localStorage`. This only happens because you asked the app to remember it, and the data never leaves your device. Because nothing is used for tracking, no consent banner is needed under the EU ePrivacy rules.
- Hosting: GitHub Pages, like any web host, processes visitors' IP addresses to serve the files (see [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)). The site is just static files. If you would rather keep everything inside the EU, copy `index.html`, `config.json`, `css/`, `js/` and `fonts/` to any EU static host.

*This describes how the software behaves; it is not legal advice.*

## One URL configures everything

```
https://<user>.github.io/timefriendzone/#title=Platform+Team&h=24&night=23-6&c-accent=0f766e&p=Ada,Europe/London&p=Kenji,Asia/Tokyo,10-19&p=Noa,Asia/Jerusalem,,71234
```

| Parameter | Example | Meaning | Default |
|---|---|---|---|
| `p` | `p=Kenji,Asia/Tokyo,10-19,12345` | A person: `name,zone[,hours[,days]]`. Repeat it once per person. Leave `hours` empty (`p=Noa,Asia/Jerusalem,,71234`) to use the team default hours with custom days. The first person sets the reference time zone. | — |
| `title` | `title=Platform+Team` | Page title | `TimeFriendZone` |
| `h` | `h=24`, `h=12`, `h=auto` | Clock format | `auto` (based on the language) |
| `lang` | `lang=de-DE` | Language/locale for dates and times | browser language |
| `theme` | `theme=dark` | `auto`, `light` or `dark` | `auto` |
| `font` | `font=system` | `geist`, `system`, `serif` or `mono` | `geist` |
| `from` | `from=6` | Hour (reference time) at which the timeline starts | `0` |
| `night` | `night=23-6:30` | Hours shown as night | `22-7` |
| `hours` | `hours=8:30-16:30` | Default working hours for people without their own | `9-17` |
| `days` | `days=71234` | Default working days (ISO digits: 1 = Monday … 7 = Sunday; `0` = none) | `12345` |
| `c-accent` | `c-accent=0f766e` | Accent colour. It also tints the working-hour cells, the bars and the focus ring. | indigo |
| `c-work` | `c-work=c7f0d8` | Working-hours cell colour | derived from the accent |
| `c-awake` | `c-awake=ffffff` | Awake, off-work cell colour | theme |
| `c-night` | `c-night=e5e5e5` | Night cell colour | theme |
| `at` | `at=2026-10-07T13:00Z` | Pre-select this hour (UTC) | — |

Hours look like `9-17` or `08:30-17:15`; overnight ranges such as `22-6` work. Colours are hex values without `#`. Text on custom colours is switched between dark and light automatically, whichever is more readable.

Everything in the table can also be changed in the **Settings** dialog, which keeps the URL up to date. **Copy link** shares the exact view.

### Where the settings come from

1. **The link.** If it lists people (`p=`), it is self-contained. If it only has settings (e.g. `#theme=dark`), those settings apply on top of your own team.
2. **This browser.** Whatever you last edited is remembered. If you open someone else's team link, you can keep it or go back to your own.
3. **`config.json`.** This is the default for first-time visitors. It uses the same parameter names, so you can configure a fork without touching code. **Settings → Export as config.json** produces this file from the current view.

```json
{
  "settings": { "title": "Platform Team", "night": "23-6", "c-accent": "0f766e" },
  "people": [
    { "name": "Me", "tz": "auto" },
    { "name": "Kenji", "tz": "Asia/Tokyo", "hours": "10-19" },
    { "name": "Noa", "tz": "Asia/Jerusalem", "days": "71234" }
  ]
}
```

`"tz": "auto"` means the visitor's own time zone.

## Deploying your own copy

1. Fork this repository.
2. Go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow in `.github/workflows/pages.yml` runs the tests and then publishes to `https://<user>.github.io/<repo>/`.

## Developing

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node --test tests/*.test.mjs  # Node 20+, no dependencies
```

- `js/tz.js` holds all time-zone, settings and URL logic. It has no DOM access.
- `tests/tz.test.mjs` contains the unit tests.
- `tests/stress.test.mjs` checks every IANA zone on every day of the year against Intl's own offset names, and round-trips a 400-person team with tricky names through a URL.
- `js/app.js` is the UI.

## Licences and attribution

- **Code:** [GPL-3.0-or-later](LICENSE). You are free to use, study, share and improve it.
- **Fonts:** [Geist and Geist Mono](https://github.com/vercel/geist-font), © The Geist Project Authors, under the [SIL Open Font License 1.1](fonts/OFL.txt). They are bundled unmodified, with no Reserved Font Name.
- **Time-zone data:** the browser's built-in IANA tz database (public domain).
- **Inspiration:** [World Time Buddy](https://www.worldtimebuddy.com/) by Helloka, LLC. TimeFriendZone is an independent implementation and is not affiliated with or endorsed by World Time Buddy. It contains none of its code, text, images or branding; the name is only used here to credit the idea. A timeline of time zones is a common, functional idea that has existed in many tools, and World Time Buddy's terms restrict copying *their* code, content and trademarks, which this project does not do.
