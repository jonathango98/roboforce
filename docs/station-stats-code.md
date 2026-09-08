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

`RF1:` followed by unpadded base64url of this JSON:

```json
{"v":1,"type":"shift-import","date":"2026-09-08",
 "stations":[{"mode":"gello","host":"UR1",
              "ops":[{"n":"Ahmed","sessions":59,"avgSec":51.42,"totalMin":50.57}]}]}
```

`mode` picks the station type and `host` is the station name. stats.py only emits
`gello` for now; the importer still understands `inference` → Inference, so codes
carrying it keep working. An operator whose sessions have no readable duration
carries `sessions` only, leaving the time cells empty for `deriveRowField` to fill.

A run only ever produces one station, but the envelope holds a list so a single
code and a combined multi-station one decode through the same path. The importer
also accepts that JSON pasted raw.

## Checking it

- `python3 stats.py -d <fixture> -t 0` and `... -t 0 --code`: the code's numbers
  should match the table's row for row.
- Paste into the Shift Report: the station fills in, Operator Summary and Shift
  Analysis update, and a reload brings the numbers back.
- Paste the same code twice: the second import updates the same block rather than
  adding a second one.
- Paste a half-copied line: it is called out as unreadable, and good lines pasted
  alongside it still import.
