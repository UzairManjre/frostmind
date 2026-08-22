"""
Model 3 -- shelf-life model, per §3 of the MVP plan: baseline is the Arrhenius equation
(k = A * exp(-Ea / (R*T))), integrated over the actual temperature-exposure history to get
% of shelf life consumed. This is math, not a trained model -- no training data needed, so
it's implemented now rather than waiting on logged data like Model 1.

The *learned correction* layer on top of this formula (per the plan) needs FROSTMIND's own
logged outcome data at a volume that doesn't exist yet -- that stays future work.

Ea/A values below are ILLUSTRATIVE, representative Q10~2-3 ranges commonly cited in
food-science/pharma cold-chain literature (see
data/references/vaccine_refrigeration_cnn_fault_detection.md for one such source) -- not
certified, product-specific constants. Replace with real published values for your exact
payload/formulation before using this for anything beyond a demo.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

R = 8.314  # J / (mol*K), universal gas constant


@dataclass
class ArrheniusProduct:
    name: str
    activation_energy_j_per_mol: float  # Ea
    pre_exponential_factor: float  # A, same time units as shelf_life_at_ref_hours
    reference_temp_c: float  # T_ref, the labeled/rated storage temperature
    shelf_life_at_ref_hours: float  # rated shelf life at T_ref


PRODUCT_LIBRARY = {
    "vaccine_generic": ArrheniusProduct(
        name="Generic refrigerated vaccine (2-8C rated)",
        activation_energy_j_per_mol=83_000,
        pre_exponential_factor=6.0e11,
        reference_temp_c=5.0,
        shelf_life_at_ref_hours=180 * 24,  # ~6 months
    ),
    "pasteurized_milk": ArrheniusProduct(
        name="Pasteurized milk (4C rated)",
        activation_energy_j_per_mol=65_000,
        pre_exponential_factor=8.0e9,
        reference_temp_c=4.0,
        shelf_life_at_ref_hours=14 * 24,  # ~2 weeks
    ),
    "fresh_produce_generic": ArrheniusProduct(
        name="Generic chilled fresh produce (2-4C rated)",
        activation_energy_j_per_mol=55_000,
        pre_exponential_factor=2.0e8,
        reference_temp_c=3.0,
        shelf_life_at_ref_hours=10 * 24,
    ),
    "meat_poultry_chilled": ArrheniusProduct(
        name="Chilled raw meat/poultry (0-2C rated)",
        activation_energy_j_per_mol=60_000,
        pre_exponential_factor=5.0e9,
        reference_temp_c=2.0,
        shelf_life_at_ref_hours=5 * 24,  # ~5 days
    ),
    "frozen_food_generic": ArrheniusProduct(
        name="Generic frozen food (-18C rated)",
        activation_energy_j_per_mol=45_000,
        pre_exponential_factor=1.0e6,
        reference_temp_c=-18.0,
        shelf_life_at_ref_hours=180 * 24,  # ~6 months
    ),
    "seafood_fresh_chilled": ArrheniusProduct(
        name="Fresh chilled seafood (0C rated)",
        activation_energy_j_per_mol=70_000,
        pre_exponential_factor=8.0e10,
        reference_temp_c=0.0,
        shelf_life_at_ref_hours=2 * 24,  # ~2 days, most perishable of the set
    ),
}


def rate_constant(temp_c, product: ArrheniusProduct):
    """Arrhenius rate constant k(T), T given in Celsius."""
    temp_k = np.asarray(temp_c, dtype=float) + 273.15
    return product.pre_exponential_factor * np.exp(-product.activation_energy_j_per_mol / (R * temp_k))


def shelf_life_consumed_fraction(temp_c_timeseries, time_hours, product: ArrheniusProduct) -> float:
    """Fraction (0-1) of shelf life consumed given a temperature-exposure history.

    Integrates k(T(t)) dt via the trapezoidal rule and compares it against the "full dose"
    implied by the rated shelf life at the reference temperature.
    """
    k_t = rate_constant(temp_c_timeseries, product)
    degradation = np.trapezoid(k_t, time_hours)
    full_dose = rate_constant(product.reference_temp_c, product) * product.shelf_life_at_ref_hours
    return float(degradation / full_dose)


def remaining_hours_at_current_temp(temp_c_timeseries, time_hours, product: ArrheniusProduct, current_temp_c: float) -> float:
    """Remaining shelf life in real hours, assuming exposure continues at current_temp_c."""
    consumed = shelf_life_consumed_fraction(temp_c_timeseries, time_hours, product)
    remaining_fraction = max(0.0, 1.0 - consumed)
    full_dose = rate_constant(product.reference_temp_c, product) * product.shelf_life_at_ref_hours
    remaining_dose = remaining_fraction * full_dose
    k_now = rate_constant(current_temp_c, product)
    return float(remaining_dose / k_now) if k_now > 0 else float("inf")


if __name__ == "__main__":
    product = PRODUCT_LIBRARY["vaccine_generic"]
    time_hours = np.linspace(0, 48, 200)
    # Simulate: rated at 5C, but a door-open excursion pushes it to 12C for a few hours mid-window.
    temp_c = np.full_like(time_hours, 5.0)
    temp_c[(time_hours > 20) & (time_hours < 26)] = 12.0

    consumed = shelf_life_consumed_fraction(temp_c, time_hours, product)
    remaining = remaining_hours_at_current_temp(temp_c, time_hours, product, current_temp_c=5.0)

    print(f"Product: {product.name}")
    print(f"Rated shelf life at {product.reference_temp_c}C: {product.shelf_life_at_ref_hours:.0f}h")
    print(f"48h exposure with a 6h excursion to 12C -> {consumed * 100:.2f}% shelf life consumed")
    print(f"Remaining shelf life if it returns to {product.reference_temp_c}C now: {remaining:.1f}h")
