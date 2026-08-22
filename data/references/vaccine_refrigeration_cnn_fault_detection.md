# Reference: vaccine-refrigeration fault detection via CNN on simulated data

Not a downloadable dataset — a methodology reference. No file to pull; kept here as a citation
because it backs the simulation-first approach already used in the FROSTMIND Stage 2/3 plan,
and it's vaccine-specific (matches FROSTMIND's stated payload categories).

## Citation

Abhiraman, B., Fotis, R., Eskin, L., & Rubin, H. (2023). Fault detection for vaccine
refrigeration via convolutional neural networks trained on simulated datasets.
*International Journal of Refrigeration*, 149, 274-285.
https://doi.org/10.1016/j.ijrefrig.2022.12.019

ScienceDirect (paywalled): https://www.sciencedirect.com/science/article/pii/S0140700722004790
Open-access mirror (PMC): https://pmc.ncbi.nlm.nih.gov/articles/PMC10373581/

## Why it's relevant

Generates training data via calibrated thermodynamic simulation of vaccine-refrigerator faults,
then trains a CNN on the simulated time series. Thermodynamic models are calibrated against
real cooling-system behavior so faults are physically plausible before any real fault data
exists — the same "simulate first, since real fault data barely exists yet" logic behind
FROSTMIND's own induced-anomaly clip approach in Stage 2.
