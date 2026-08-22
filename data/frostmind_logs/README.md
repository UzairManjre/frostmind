# FROSTMIND hardware logs — empty, waiting on real data

Put your combined `logToSerial` capture here once you've run the plan's build order step 4
(normal baseline session + 5-10 induced-anomaly clips): `frostmind_log.csv` with columns
`ts, temp, humidity, door, rate_of_change, session_label`.

`../../scripts/train_model1_frostmind.py` picks it up automatically once it exists — until
then it exits with instructions instead of a stack trace.
