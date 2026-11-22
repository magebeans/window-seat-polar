# Night-before checklist (on the iPhone)

Do this on Wi-Fi, the evening before. It takes about 15 minutes, most of it the download.

## 1. Install

- [ ] In **Safari**, open the site URL.
- [ ] Share → **Add to Home Screen** → Add.
- [ ] Close Safari. From now on open **only the Home Screen icon**. Storage in the home-screen app
      is separate from Safari's, so anything cached in a Safari tab does not count.

## 2. Confirm it is fully cached

- [ ] Open the app from the icon. On the start card, the line under the flight should change to
      `… cached, ready for offline ✓`. If it is still counting, leave the app open with the screen
      on until it finishes.
- [ ] Tap **Offline status & settings** on the start card (or ⚙︎ once started) and check:
  - [ ] **Display mode** says *standalone (home screen) ✓*.
  - [ ] The status line is green: `925 MB of 925 MB cached, ready for offline ✓` (the exact size
        depends on the build).
  - [ ] **Persistent storage** says *granted ✓*. If it says *not granted*, the data can still stay;
        iOS rarely evicts home-screen apps, but it is worth knowing.
  - [ ] Tap **Verify** → the log says `all N files present ✓`.
  - [ ] Optional: **Deep verify** re-hashes every byte (about a minute).
- [ ] Check that the **Route** line names the right flight and date.

## 3. Airplane mode

- [ ] Turn on **Airplane Mode** and make sure Wi-Fi is off too (Control Centre can quietly turn
      Wi-Fi back on).
- [ ] Swipe the app away in the app switcher, then reopen it from the icon. This is the real test:
      a cold start with no network.
- [ ] No red banner appears.

## 4. Position slider

- [ ] Tap **Start**. The plane appears where the schedule says it is (at SEA until 4:10 PM wheels-up).
- [ ] Drag the round thumb on the timeline strip: the map, the "Out the window" list and the
      Seattle/Doha times under the strip follow. It keeps moving at flight speed from wherever you leave it.
- [ ] **⏸** freezes it (for delays on the ground); **Now** snaps back to the schedule.
- [ ] Close and reopen the app: it resumes where you left it, plus the elapsed time.

## 5. Tiles and features

- [ ] Pinch-zoom around your current location: streets and labels draw (detail near SEA goes to z13).
- [ ] Drag the slider to about two-thirds:
  - [ ] The map follows the fake plane over the daylight stretch, with labels.
  - [ ] **Out the window** lists features with ◀ LEFT / RIGHT ▶, the km off track and minutes to abeam.
  - [ ] Tap one: a summary appears.
  - [ ] The timeline strip has a red marker, and its label reads *Daylight for …* or *Next daylight in …*.
- [ ] ⚙︎ → **Network fetches** still reads **0**.
- [ ] Tap **Now** to return to the schedule.

## 6. Keep-awake and power

- [ ] ⚙︎ → **Keep screen on** shows `api`, `video` or `api+video`. Lock the phone only if you mean to.
      If the screen still dims, turn on ⚙︎ → *Always use the video keep-awake fallback*.
- [ ] Settings → Display & Brightness → Auto-Lock: set it to *Never* for the flight as a backstop.
- [ ] Bring a charger or power bank. GPS plus a lit screen drains the battery fast.

## On board

- When you can see something you can place (a coastline, a big lake), drag the slider so the plane
  sits there; everything ahead then lines up. The seatback map is a good reference too.
- Use ⬆︎ (track-up) so the left of the screen is the left of the plane.
