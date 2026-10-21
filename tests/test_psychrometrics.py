"""Pinned psychrometric values for drying-log air readings (see backend/psychrometrics.py)."""

import pytest
from backend.psychrometrics import psychrometrics


@pytest.mark.parametrize(
    'temp_f, rh, gpp, dew_point_f',
    [
        # ASHRAE Handbook – Fundamentals psychrometric chart (sea level) reads 55 GPP / 50.5 °F,
        # 65 GPP / 55 °F, 61 GPP / 54 °F and 26 GPP / 32 °F for these four; the Magnus fit and
        # whole-grain rounding land within one grain and one degree of the chart.
        (70, 50, 54, 51),
        (75, 50, 65, 55),
        (80, 40, 61, 54),
        (32, 100, 26, 32),
        # DryScope's Day 1 preset: wet chamber at 74 °F / 72 % and dehumidifier exhaust 86 °F / 36 %.
        (74, 72, 91, 64),
        (86, 36, 67, 56),
        # Its unaffected control room and outside air.
        (68, 45, 46, 46),
        (62, 74, 61, 54),
    ],
)
def test_gpp_and_dew_point_match_the_standard_chart(temp_f, rh, gpp, dew_point_f):
    result = psychrometrics(temp_f, rh)
    assert result['gpp'] == gpp
    assert result['dew_point_f'] == dew_point_f
    assert result['dew_point_depression_f'] == max(0, temp_f - dew_point_f)


def test_vapor_pressure_and_enthalpy_at_seventy_degrees_half_saturated():
    result = psychrometrics(70, 50)
    # Saturation at 21.1 °C is 25.0 hPa; half of it is 12.5 hPa = 0.369 inHg.
    assert result['vapor_pressure_inhg'] == 0.37
    # h = 0.24·70 + 0.00778·(1061 + 0.444·70) = 16.8 + 8.5 BTU/lb.
    assert result['enthalpy_btu_lb'] == 25.3


def test_saturated_air_has_no_dew_point_depression_and_dry_air_has_no_grains():
    assert psychrometrics(100, 100)['dew_point_depression_f'] == 0
    # A 1 % floor keeps the dew-point logarithm finite; the value is reported, never invented.
    assert psychrometrics(-40, 1)['gpp'] == 0
    assert psychrometrics(70, 0)['gpp'] == psychrometrics(70, 1)['gpp']
    assert psychrometrics(70, 150)['gpp'] == psychrometrics(70, 100)['gpp']


def test_monotonic_in_temperature_and_humidity():
    assert psychrometrics(80, 50)['gpp'] > psychrometrics(70, 50)['gpp']
    assert psychrometrics(70, 60)['gpp'] > psychrometrics(70, 50)['gpp']
    assert psychrometrics(70, 60)['dew_point_f'] > psychrometrics(70, 50)['dew_point_f']
