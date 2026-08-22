# Cold Chain Shipment Silent Failure Dataset

**Downloaded** (manually, via your own Kaggle login) 2026-08-21.

## Important correction vs. the original pitch

This was flagged as "your primary supplement... it's got real failure labels." Having checked
the actual dataset page, that's not accurate: the author describes it as **"8,000 simulated
cold chain shipments"** — synthetic data with synthetic labels, not real-world failure
incidents. It's still usable (good schema match, CC0 license, no auth needed once downloaded),
but it belongs in the same bucket as the vaccine-refrigeration CNN paper — simulation-based —
not alongside NAB's genuinely real machine-failure data. Frame it that way in the presentation.

## Dataset details (from the Kaggle page, checked 2026-08-21)

- URL: https://www.kaggle.com/datasets/skarin/cold-chain-shipment-silent-failure-dataset
- Author: skarin · Updated ~5 months ago · License: CC0 Public Domain
- 1 file: `shipment-sensor-dataset.csv` (~987 KB)
- 8,000 rows, 24 columns: shipment identity, transit duration, door-open count, temperature
  stats (mean/max/min/std/recovery rate), humidity stats (mean/std/max), package type, product
  volume, fill ratio, carrier ID, origin/destination zone, leg count, sensor-gap hours,
  vibration index, 3 engineered latent features, and 2 binary targets.
- Usability score 9.41, but low engagement: 0 upvotes, 122 downloads, 0 comments, no
  community quality tags — worth a skim of the data itself before leaning on it heavily.

**Correction vs. the Kaggle page text:** the page's "About Dataset" prose mentions two binary
targets (`label` and `silent_failure`), but the actual downloaded CSV only contains
`silent_failure` — 19.7% positive (1,574/8,000), matching the page's stated rate. There is no
`label` column in the file. Verified by inspecting the header directly, not just the page text.

## Used by

`scripts/train_model1_shipment.py` — trains Model 1 (Isolation Forest) on `silent_failure=0`
rows (70% split), evaluates recall/FPR/ROC-AUC on the held-out normal 30% plus all
`silent_failure=1` rows. See `scripts/README.md` for current results.
