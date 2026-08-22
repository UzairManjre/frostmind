# NAB — Machine Temperature System Failure

Source: [Numenta Anomaly Benchmark (NAB)](https://github.com/numenta/NAB), `data/realKnownCause/machine_temperature_system_failure.csv`.
Pulled 2026-08-21 via raw.githubusercontent.com (public repo, no auth needed).

Real (not simulated) temperature sensor readings from an internal Numenta machine, including
a known catastrophic failure. This is the field's standard benchmark for this class of
problem — use it to validate the Stage 2 Isolation Forest before applying it to FROSTMIND's
own logged sessions, per the plan's suggestion to report a real precision/recall number
against an established benchmark first.

## Files

- `machine_temperature_system_failure.csv` — 22,695 readings, columns `timestamp,value`, 5-minute cadence, 2013-12-02 to 2014-02-19.
- `combined_labels.json` — full NAB point-label file (all series). Included as-is for reference.
- `combined_windows.json` — full NAB anomaly-window file (all series). Included as-is for reference.
- `machine_temperature_labels.json` — just this series' labels, extracted from the two files above for convenience:
  4 anomaly windows (includes the labeled catastrophic-failure window) and their corresponding label points.

## Citation

Ahmad, S., Lavin, A., Purdy, S., & Agha, Z. (2017). Unsupervised real-time anomaly detection
for streaming data. *Neurocomputing*, 262, 134-147. https://doi.org/10.1016/j.neucom.2017.04.070
