"""Shared matplotlib style for the Model 4/5 report figures (docs/figures/model4_5/).

Colours are the dataviz skill's validated light-mode categorical palette, used in fixed slot
order (never cycled); thin marks, recessive grid, text in ink tokens rather than series colours.
"""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIG_DIR = ROOT / "docs" / "figures" / "model4_5"

SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
TEXT_PRIMARY = "#0b0b0b"
TEXT_SECONDARY = "#52514e"
GRID = "#e4e3df"
SURFACE = "#ffffff"
SEQ_BLUE = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]


def apply():
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update(
        {
            "figure.facecolor": SURFACE,
            "axes.facecolor": SURFACE,
            "axes.edgecolor": GRID,
            "axes.labelcolor": TEXT_SECONDARY,
            "axes.titlecolor": TEXT_PRIMARY,
            "axes.titlesize": 12,
            "axes.titleweight": "bold",
            "axes.titlelocation": "left",
            "axes.labelsize": 10,
            "axes.grid": True,
            "axes.axisbelow": True,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "grid.color": GRID,
            "grid.linewidth": 0.6,
            "xtick.color": TEXT_SECONDARY,
            "ytick.color": TEXT_SECONDARY,
            "xtick.labelsize": 9,
            "ytick.labelsize": 9,
            "legend.frameon": False,
            "legend.fontsize": 9,
            "lines.linewidth": 2,
            "font.family": "DejaVu Sans",
            "savefig.dpi": 160,
            "savefig.bbox": "tight",
        }
    )


def save(fig, name: str) -> Path:
    path = FIG_DIR / name
    fig.savefig(path)
    plt.close(fig)
    print(f"figure -> {path.relative_to(ROOT)}")
    return path
