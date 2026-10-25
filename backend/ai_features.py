"""Server rollout switches. An empty AI_FEATURES enables nothing."""

import os

AI_FEATURES = frozenset(
    filter(None, (v.strip().lower() for v in os.getenv('AI_FEATURES', '').split(',')))
)


def enabled(feature):
    return feature in AI_FEATURES
