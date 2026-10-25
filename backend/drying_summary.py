"""A bounded narrative over deterministic monitoring facts; never a command or a reminder."""

import json
import re
from decimal import Decimal
from pydantic import Field

try:
    from .contracts import StrictModel
except ImportError:
    from contracts import StrictModel


class DryingSummary(StrictModel):
    text: str = Field(min_length=1, max_length=600)


def numbers(text):
    return {Decimal(n) for n in re.findall(r'(?<![\w.])-?\d+(?:\.\d+)?', text)}


def validate_summary(result, facts):
    text = result.text.strip()
    if not text or len(text.split()) > 60 or '$' in text:
        raise ValueError('Invalid drying summary.')
    if not numbers(text).issubset(numbers(json.dumps(facts))):
        raise ValueError('Ungrounded drying summary.')
    if facts['status'] != 'dry_standard_met' and re.search(
        r'\b(dry|complete|completed|finished)\b', text, re.I
    ):
        raise ValueError('Drying is not verified complete.')
    # No instructions or financial/scope advice, including spelled-out invented quantities.
    if re.search(
        r'\b(price|cost|dollars?|usd|charge|bill|demoli\w*|remov\w*|add|extend\w*|continu\w*|shorten\w*|prolong\w*|resume\w*|stop\w*|keep|maintain\w*|reduce\w*|recommend\w*|should|must|need to|install|replace|increase|decrease|equipment|fans?|dehumidifiers?|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\b',
        text,
        re.I,
    ):
        raise ValueError('The summary must only describe the recorded facts.')
    return text
