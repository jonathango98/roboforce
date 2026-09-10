# Station numbers by pasteable code

## What it replaces

Reading `stats.py`'s per-operator table off a station terminal and retyping every
name, session count, and time into the Shift Report by hand.

Now the station prints one line, and the Shift Report takes that line.

## At the station

```
python3 stats.py --code --name UR1   # names this station, and remembers it
python3 stats.py --code              # every run after — today's numbers
python3 stats.py --code -t 1         # yesterday
python3 stats.py --code | pbcopy     # straight to the clipboard
python3 stats.py --qr                # ... and draw it for a phone to scan
python3 stats.py --qr --email someone@else.com   # ... to someone else
```

`--code` (also spelled `--hash`) prints the code alone on stdout and a one-line
check — station, date, operator count — on stderr, so piping stays clean. It
covers **today** unless `-t` says otherwise, since a code stands for one day's
report rather than the all-time scan a bare run does.

`--name` is given once per machine: it writes the name to `~/.rf-station` and
later runs read it back. Set it to the label the Shift Report uses for that
station and the code lands on the right block by itself. `$RF_STATION` overrides
for a single run without overwriting the saved name; failing all of those, the
code carries the hostname.

The interactive TUI (`stats.py` with no arguments) has the same thing on the **`c`**
key: it shows the code, `n` sets the station name (saving it the same way), and
`c` again copies it (via `pbcopy`, `wl-copy`, `xclip`, or `xsel` — whichever the
station has).

`--qr`, and **`p`** in the TUI, draw the code as a QR code for a phone camera to
read off the station screen. The clipboard only helps on the station PC, and
whoever needs the numbers is rarely sitting at it. Scanning opens the phone's
mail app on a draft that is already addressed and carries the code, with the
station and date as the subject; `--email ADDRESS` redirects it for one run.

The code travels as `mailto:?subject=<station and date>&body=<code>` rather than
bare text because a phone camera only acts on payloads it recognises — iOS
decodes a plain-text code and then discards it, reporting "no usable data".

## In the Shift Report

**Station Input → Paste stats code**. Paste one code, or several — one per line,
one per station machine — then press **Import**.

Before anything is written, each code shows as a row: station name, mode, operator
count and names, and a dropdown for where it lands. The dropdown offers existing
blocks **of that code's type only** (so GELLO numbers can never fall into columns
that mean something else) plus "+ New …". A block whose label matches the code's
station name is preselected, so a re-paste updates in place instead of duplicating.
A code whose date differs from the report's date is flagged but still importable.

Importing **replaces** the target station's rows — a code is that station's whole
day, so merging would strand operators who no longer appear.

## The code

`RF2:` followed by unpadded base64url of a packed binary body. All integers are
big-endian; a *varint* is LEB128 — seven bits per byte, high bit set while more
bytes follow.

```
byte  0      format version = 2
bytes 1-2    date, uint16: ((year - 2020) << 9) | (month << 5) | day
byte  3      station count
  per station:
    byte     mode: 0 = gello, 1 = inference
    byte     host length, then host bytes (UTF-8)
    varint   operator count
      per operator:
        byte    name length, then name bytes (UTF-8)
        varint  session count
        varint  avgSec in hundredths — 0 means no readable durations
        varint  totalMin in hundredths — omitted when avgSec was 0
```

`mode` picks the station type and `host` is the station name. stats.py only emits
`gello` for now; the importer still understands `inference` → Inference, so codes
carrying it keep working. `RF2_MODES` is indexed by the mode byte, so entries are
appended to it and never reordered.

An operator whose sessions have no readable duration carries a zero `avgSec` and
nothing after it, leaving the time cells empty for `deriveRowField` to fill. A
session that *has* a duration can never average zero, which is what lets that
double as the absence flag.

A run only ever produces one station, but the body holds a count so a single code
and a combined multi-station one decode through the same path.

### Why it is not JSON

RF1 spelled the same numbers out as JSON before base64:

```json
{"v":1,"type":"shift-import","date":"2026-09-08",
 "stations":[{"mode":"gello","host":"UR1",
              "ops":[{"n":"Ahmed","sessions":59,"avgSec":51.42,"totalMin":50.57}]}]}
```

That row costs 58 bytes to carry about 12 bytes of information — field names
repeated once per operator, numbers as text, then base64 adding a third on top. A
twelve-operator day ran past a thousand characters, which is a QR code too dense
for a phone to read off a screen. Packed binary is roughly five times shorter
(a twelve-operator day: 1022 characters down to 218) and loses nothing: `avgSec`
and `totalMin` are both carried, in hundredths.

Compression is not the answer here and was measured: at these sizes deflate's
header and tables eat most of the gain, and over a packed body it makes the code
*bigger*. Nothing compresses on either end.

**`RF1:` codes still import**, so stations can be updated one at a time — but a
station emitting `RF2:` needs this page deployed first. The importer also accepts
the RF1 JSON pasted raw.

## Checking it

- `python3 stats.py -d <fixture> -t 0` and `... -t 0 --code`: the code's numbers
  should match the table's row for row.
- `... -t 0 --qr`: scan it with a phone and check the text matches the code line
  printed under it.
- Paste into the Shift Report: the station fills in, Operator Summary and Shift
  Analysis update, and a reload brings the numbers back.
- Paste the same code twice: the second import updates the same block rather than
  adding a second one.
- Paste a half-copied line: it is called out as unreadable, and good lines pasted
  alongside it still import.
