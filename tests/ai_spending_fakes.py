"""Prepared counting and confirmed-scope stand-ins used by the workspace API fixture."""

from types import SimpleNamespace
from backend.contracts import AIResult


async def confirmed_scope(schema, *args, **kwargs):
    return AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])


def counting_client():
    """Prepared voice-note adapter: synthetic input counting before the route's fake generation."""

    async def count_tokens(**kwargs):
        return SimpleNamespace(total_tokens=100)

    return SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(count_tokens=count_tokens)))
