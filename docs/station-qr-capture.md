# Station test-count capture via iPhone QR relay (no internet)

## Context

Today you run `stats.py` in a terminal on each isolated test station, read the
per-operator table off the screen, and **re-type the numbers by hand** into the
Shift Report tool on your laptop. Slow and error-prone.

New flow: each station prints a **QR code**. You walk the floor scanning each
station's QR with your iPhone's **native Camera app**. The phone opens a small
relay page that **accumulates every station you scan** (with on-phone
confirmation as you go). When done, the relay page shows **one combined QR**
containing all stations' data. You hold the phone up to the **laptop webcam**, the
Shift Report scans that single code, and every station fills in at once.

### Why this shape

- **No data crosses the internet.** Each station QR carries its data in the URL
  *fragment* (`#...`), which is never sent to any server — the phone decodes it
  locally in JavaScript. The only network use is the phone loading a static relay
  page from the laptop over **local Wi-Fi**.
- **No backend.** Everything stays static files served by `serve.sh`.
- **Camera permissions work.** The phone never needs in-browser camera access (the
  native Camera app does the scanning); the laptop's webcam runs on
  `http://localhost`, a secure origin where `getUserMedia` is allowed.

### Locked-in decisions

- **GELLO and Inference are the same UR machine**; the `stats.py` run mode is the
  station type — default run = `GELLO`, `-i` = `INFERENCE`. No `--station` flag.
- **Multiple UR machines, each doing both modes.** Every payload is keyed by
  **(station name, mode)**, so machine `UR1` produces two independent entries
  (`UR1·gello`, `UR1·inference`); three machines doing both → up to six entries,
  all merged into the one combined QR and routed to matching station blocks on
  import. Station name defaults to the machine hostname, overridable with
  `--name UR1` so labels are clean and stable.
- **UMI stays manual** (out of scope for QR).
- Stations are spread across a floor, so the relay (native camera + on-phone
  confirmation + one final scan) is used rather than a tethered iPhone webcam.

### Why not Continuity Camera / iPhone-as-webcam

- **Apple Continuity Camera** works as a browser webcam only in Safari (Chrome
  often won't detect it) and **requires the iPhone mounted, locked, motionless** —
  Apple disables it hand-held. Can't be used to walk around scanning.
- **Third-party webcam apps** (Camo/EpocCam) do allow hand-held use, but you'd be
  at a far station scanning "blind" with no view of the laptop screen, and they
  require installing software. The native-camera relay gives on-phone confirmation
  and needs no installs — better for spread-out stations.

## Data mapping (stats.py → Shift Report)

Shift Report fields (`shift-report.html:367`):

- `GELLO`: `sessions`, `avgTime` (sec), `totalTime` (min)
- `INFERENCE`: `count`

Per operator, `stats.py` already computes: `sessions = s['total']`,
`avgSec = mean(durations)`, `totalMin = sum(durations)/60`, and (inference)
`count = s['total']`.

## Components

### 1. `rf-scripts/stats.py` — add `--qr` (deps already installed: `qrcode`, `Pillow`)

- Add `--qr` flag, plus a relay target: `--relay URL` (e.g.
  `http://192.168.1.50:8080/relay.html`), falling back to env `RF_RELAY` or a
  one-line config file `~/.rf-relay` so each station is set up once. (The station
  never connects anywhere — it only prints this string; the phone is what opens it.)
- Add `--name NAME` for the station identifier (default `socket.gethostname()`),
  so each UR machine is labeled cleanly and consistently (`UR1`, `UR2`, …). This
  becomes `payload["host"]` — the key the accumulator and importer match on.
- After the existing table still prints, when `--qr` is set, build a compact
  per-station payload:

  ```python
  payload = {
    "v": 1,
    "mode": "inference" if args.inference else "gello",
    "date": (target_date or date.today()).isoformat(),
    "host": args.name or socket.gethostname(),
    "ops": [...],   # GELLO: {n, sessions, avgSec, totalMin}; inference: {n, count}
  }
  ```

- Encode as `RELAY_URL + "#" + base64url(json.dumps(payload))` and render an ASCII
  QR in the terminal:

  ```python
  import qrcode
  qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2)
  qr.add_data(url); qr.make(fit=True); qr.print_ascii(invert=True)
  ```

  Print a one-line hint (`mode`, `host`, `date`, operator count) to confirm before
  scanning.

### 2. `rf-admin/relay.html` — new static page the iPhone opens (accumulator)

Loaded by the phone's native camera via the URL in each station QR. **Uses no
camera itself** — only reads the fragment and draws QR codes.

- On load + on `hashchange`: read `location.hash`, base64url-decode → payload.
  Merge into an accumulator in the phone's `localStorage` (key e.g.
  `rf-relay-inbox`), keyed by `host + "|" + mode` so re-scanning a station
  **updates** rather than duplicates. Track `date`.
- Render a running list — "Captured: UR1 (GELLO, 4 ops), UR1 (Inference, 4 ops)…"
  with a count — so you see progress as you walk the floor.
- Buttons: **"Show combined QR"** renders ONE QR (vendored encoder) of
  `{v:1, type:"shift-import", date, stations:[ {mode,host,ops}, ... ]}`; and
  **"Clear"** to reset for the next shift.
- Capacity: a handful of UR machines × a few operators is a few hundred bytes —
  comfortably within one QR. (Verify; if it ever overflows, the encoder still
  draws — just confirm the laptop can read it.)
- Vendor `rf-admin/vendor/qrcode.min.js` (qrcode-generator, ~20 KB, single file,
  no deps) for drawing. Local `<script src>` so it works offline after first load.

### 3. `rf-admin/shift-report.html` — "Scan station QR" import (laptop webcam)

- Vendor `rf-admin/vendor/jsqr.min.js` (jsQR, ~40 KB, single file) for decoding;
  local `<script src>`.
- Add a **"Scan station QR"** button in the Station Input card next to the
  `+ UMI / + GELLO / + Inference` buttons (`shift-report.html:315`).
- Click → modal with `<video>` from
  `navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })`, drawn
  to a hidden `<canvas>` each frame and decoded with `jsQR` in a
  `requestAnimationFrame` loop. On decode, stop the stream and close.
- Validate `type === "shift-import"`; warn (allow) if `date` ≠ selected
  `reportDate`. **Loop over `payload.stations`** (one entry per (name, mode)),
  importing each independently:
  - `mode` → `type` (`gello`→`GELLO`, `inference`→`INFERENCE`).
  - Find an existing station of that **type** whose `label === host`; else create
    one using the existing `ur-N` id scheme from `addStation()`
    (`shift-report.html:773`) but with `label = host`. Match is on **(type, host)**,
    so `UR1·gello` lands in a GELLO block labeled `UR1` and `UR1·inference` in a
    separate INFERENCE block also labeled `UR1` — multiple machines and both modes
    coexist without collision, and re-scanning updates in place.
  - Overwrite that station's `stationRows` from `ops`, mapping fields
    (GELLO: `sessions/avgTime/totalTime` ← `sessions/avgSec/totalMin`;
    INFERENCE: `count`). Reuse existing structures — do not duplicate rendering.
- After the loop: `syncStationInputs()` → `renderStations()` →
  `renderPersonSummary()` → `renderAnalysis()` → `saveCurrentDate()` (the same
  refresh sequence the existing mutators use, e.g. `addRow`, `shift-report.html:740`).
- Show a line: "Imported N stations / M operators".

## Verification

1. **Script**: with a fixture dir of `*/session_meta.json`,
   `python3 stats.py --qr --name UR1 --relay http://<laptop-ip>:8080/relay.html` →
   table still prints, ASCII QR + hint show `mode: gello`. Repeat with `-i` →
   `mode: inference`. Decode the QR with a phone to confirm URL + fragment.
2. **Relay page**: `./serve.sh`; on the phone (same Wi-Fi) open the relay URL with
   a sample fragment (or scan a real station QR). Confirm the captured list grows
   per scan, re-scanning a host updates in place, and "Show combined QR" renders
   one code embedding all stations.
3. **Import**: on the laptop, Shift Report → **Scan station QR** → hold the phone's
   combined QR to the webcam. Confirm GELLO (UR) + Inference stations appear with
   operators, sessions, avg sec, total min / counts populated, and that Operator
   Summary + Shift Analysis update. Re-scan → no duplicates. Reload → persists from
   `localStorage`.

## Out of scope

- UMI capture (stays manual).
- Any networking beyond the phone loading static pages over LAN; no backend.
