# Temperature Readings: IoT Devices

**Downloaded** (manually, via your own Kaggle login) 2026-08-21.

- URL: https://www.kaggle.com/datasets/atulanandjha/temperature-readings-iot-devices
- General IoT temperature data, not cold-chain-specific. 97,606 readings,
  2018-07-28 to 2018-12-08, columns: `id, room_id/id, noted_date, temp, out/in`.
- **No anomaly labels at all** — useful only as extra unlabeled normal-baseline volume, not for
  a scored Model 1 checkpoint.

## Used by

`scripts/explore_iot_temp.py` — profiles it (row count, date range, temp stats split by
in/out room) and writes `models/iot_temp_profile.json`. No model is trained on it.
