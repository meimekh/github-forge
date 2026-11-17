# QA — local verification against the official kit suite

Run with the portable Node 26 on this machine:

```
C:/script/x/node26/node-v26.13.1-win-x64/node.exe scripts/selftest.js --keep
```

`scripts/selftest.js` starts the kit's own sealed env (`program/env/server.mjs`) on a free ephemeral
port, starts this entry against it with the trial bearer token, waits for the env to say done, reads
the env's own export and stops both children by PID. Nothing here is self-reported: the numbers are
the env's export and its own log lines.

## Last run — 2026-11-17

```
[selftest] env ready; starting the entry
[entry] listening on port 64106
[entry] registered; waiting for the env to say done
[entry] done

checks   120/120  working=1
  git       30/30
  graphql   20/20
  issues    15/15
  mcp       15/15
  protocol  5/5
  pulls     20/20
  repos     15/15

every check passed

perf     181 points  calibrated=true
  push   p50    146.601 ms  points 50
  clone  p50     50.477 ms  points 50
  read   p50    377.509 ms  points 50
  write  p50    255.973 ms  points 31
  perf_p50_us 163526

elapsed  7 s
```

An earlier run of the same commit reported 120/120 with `read` at ~1782 ms and 163 performance
points; the run above reports `read` at ~378 ms and 181 points. The difference is unexplained here —
the two runs measured the same code on the same machine, so machine load is the likely cause. It is
recorded because it shows the timings are noisy and should not be read as a tuned result.

## What this does not prove

- The four timings are this machine's, not the production sandbox's.
- Byte-for-byte determinism between two runs of the same instance was not compared; no clock and no
  randomness reach any response by construction, but that comparison was not run.