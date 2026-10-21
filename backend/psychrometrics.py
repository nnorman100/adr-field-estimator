"""Psychrometric values for drying-log air readings; deterministic, never model output.

Dry-bulb temperature (°F) and relative humidity (%) become grains of moisture per pound of dry
air (GPP), dew point (°F), vapor pressure (inHg) and specific enthalpy (BTU/lb), the quantities
the IICRC S500 Standard for Professional Water Damage Restoration uses to document a drying
chamber. The equations are the standard ones, as ported from DryScope's lib/psychrometrics.ts:

- Saturation vapor pressure over water: the Magnus form e_s = 6.1121 · exp(17.67·T / (T + 243.5))
  hPa with T in °C (Bolton 1980 coefficients; Buck's 6.1121 hPa leading constant).
- Humidity ratio W = 0.62198 · e / (P − e) at standard sea-level pressure P = 1013.25 hPa, with
  7000 grains per pound (ASHRAE Handbook – Fundamentals, Psychrometrics chapter).
- Dew point by inverting the Magnus form.
- Specific enthalpy h = 0.240·t + W·(1061 + 0.444·t) BTU/lb dry air with t in °F (ASHRAE,
  inch-pound form).

Checks pinned in tests/test_psychrometrics.py: 70 °F / 50 % RH gives 54 GPP and a 51 °F dew point;
the ASHRAE chart reads 55 GPP and 50.5 °F there, the difference being the 7000-grain rounding
and the Magnus fit. Altitude is not corrected; Bakersfield is near sea level.
"""

import math

STANDARD_PRESSURE_HPA = 1013.25
GRAINS_PER_POUND = 7000
HPA_TO_INHG = 0.02953


def saturation_vapor_pressure_hpa(temp_c):
    return 6.1121 * math.exp((17.67 * temp_c) / (temp_c + 243.5))


def psychrometrics(temp_f, relative_humidity):
    """GPP, dew point, vapor pressure and enthalpy for one dry-bulb/RH pair.

    Relative humidity is clamped to 1–100 % as the source did; the contract already rejects
    values outside that range, so the clamp only guards arithmetic.
    """
    temp_f = float(temp_f)
    rh = min(100.0, max(1.0, float(relative_humidity)))
    temp_c = (temp_f - 32) * 5 / 9
    vapor_hpa = saturation_vapor_pressure_hpa(temp_c) * rh / 100
    humidity_ratio = 0.62198 * vapor_hpa / max(1.0, STANDARD_PRESSURE_HPA - vapor_hpa)
    alpha = math.log(max(0.001, vapor_hpa / 6.1121))
    dew_point_c = 243.5 * alpha / (17.67 - alpha)
    dew_point_f = round(dew_point_c * 9 / 5 + 32)
    return {
        'gpp': round(humidity_ratio * GRAINS_PER_POUND),
        'dew_point_f': dew_point_f,
        'dew_point_depression_f': max(0, round(temp_f - dew_point_f)),
        'vapor_pressure_inhg': round(vapor_hpa * HPA_TO_INHG, 3),
        'enthalpy_btu_lb': round(0.24 * temp_f + humidity_ratio * (1061 + 0.444 * temp_f), 1),
    }
