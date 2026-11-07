"""Funded Gemini generation and request deadlines, with caller-owned runtime bindings."""

import asyncio
import json
import logging
import time
from functools import wraps

import anyio
from fastapi import HTTPException
from pydantic import ValidationError
from google import genai
from google.genai import types, errors as genai_errors, _transformers as genai_transformers

try:
    from .ai_spending import ReservedCall, SpendingError, rest_cost, rest_allowance, CompanySpending
except ImportError:
    from ai_spending import ReservedCall, SpendingError, rest_cost, rest_allowance, CompanySpending


def create_ai_client(project, location):
    return genai.Client(
        enterprise=True,
        project=project,
        location=location,
        # Each billable attempt needs its own company hold. Audit retries are
        # explicit in the caller; SDK retries must not multiply one reserved attempt.
        http_options=types.HttpOptions(
            timeout=95000, retry_options=types.HttpRetryOptions(attempts=1)
        ),
    )


def parse_json_from_llm(text):
    text = (text or '').strip()
    if text.startswith('```'):
        text = '\n'.join(text.splitlines()[1:])
        if text.rstrip().endswith('```'):
            text = text.rstrip()[:-3]
    return json.loads(text)


class Generation:
    def __init__(self, *, client, stored, workspaces, parser, output_limit, log, deadline_seconds):
        self._client = client
        self._stored = stored
        self._workspaces = workspaces
        self._parser = parser
        self._output_limit = output_limit
        self._log = log
        self._deadline_seconds = deadline_seconds
        self.jobs = set()

    def background(self, work):
        job = asyncio.ensure_future(work)
        self.jobs.add(job)

        def finished(job):
            self.jobs.discard(job)
            if not job.cancelled():
                job.exception()

        job.add_done_callback(finished)
        return job

    async def within(self, deadline, method, *args, undo=None):
        """A ledger call answered only until the deadline. Unfinished work still completes in the
        background, so a hold stays durable; undo then reverses a result nobody received."""
        job = self.background(self._stored(method, *args))
        done, _ = await asyncio.wait({job}, timeout=max(0, deadline - time.monotonic()))
        if done:
            return job.result()
        if undo:
            job.add_done_callback(
                lambda job: (
                    job.cancelled()
                    or job.exception()
                    or self.background(self._stored(undo, job.result()))
                )
            )
        raise TimeoutError

    def generation_config(self, schema, model, operation, wire_schema=None, thinking_level=None):
        return types.GenerateContentConfig(
            response_mime_type='application/json',
            response_schema=wire_schema or schema,
            thinking_config=(
                types.ThinkingConfig(thinking_level=thinking_level) if thinking_level else None
            ),
            max_output_tokens=self._output_limit(model, operation),
        )

    async def reserve_generation(self, contents, model, operation, config, spending, deadline):
        store, uid = spending
        try:
            ledger = await self.within(
                deadline, CompanySpending.actor, store, uid, self._workspaces()
            )
            await self.within(deadline, ledger.check_available, rest_allowance(model, 0, operation))
            client, counted = await self.count_input(contents, model, operation, config, deadline)
            held = await self.within(
                deadline,
                ReservedCall.start,
                store,
                uid,
                self._workspaces(),
                model,
                operation,
                getattr(counted, 'total_tokens', None),
                undo=ReservedCall.release_unused,
            )
        except asyncio.TimeoutError:
            raise HTTPException(
                504, 'AI preparation timed out. Retry; your saved work is unchanged.'
            )
        held.client, held.config = client, config
        return held

    async def count_input(self, contents, model, operation, config, deadline):
        try:
            client = self._client()
            options = config.model_dump(exclude_none=True)
            # CountTokens' GenerationConfig cannot accept Pydantic model classes.
            # Use the pinned SDK's own generation serializer so both requests count
            # the identical schema, including nested definitions/property ordering.
            options['response_schema'] = genai_transformers.t_schema(
                getattr(client, '_api_client', None),
                options['response_schema'],
            )
            counted = await asyncio.wait_for(
                client.aio.models.count_tokens(
                    model=model,
                    contents=contents,
                    config=types.CountTokensConfig(
                        generation_config=types.GenerationConfig(**options),
                    ),
                ),
                timeout=min(15, deadline - time.monotonic()),
            )
        except asyncio.TimeoutError:
            raise
        except Exception as error:
            self._log(
                'Vertex token count failed',
                logging.ERROR,
                operation=operation,
                model=model,
                outcome=type(error).__name__,
            )
            raise HTTPException(
                502, 'AI could not be prepared. Retry; your saved work is unchanged.'
            )
        return client, counted

    async def generate(
        self,
        schema,
        contents,
        model,
        operation,
        inspection_id,
        wire_schema=None,
        thinking_level=None,
        timeout=100,
        check=None,
        invalid_detail=None,
        *,
        spending,
    ):
        started = time.monotonic()
        deadline = started + timeout
        outcome = 'cancelled'
        error_fields = {}
        ledger = None
        reservation = None
        cost = None
        try:
            if isinstance(spending, ReservedCall):
                held = spending
            else:
                config = self.generation_config(
                    schema, model, operation, wire_schema, thinking_level
                )
                held = await self.reserve_generation(
                    contents,
                    model,
                    operation,
                    config,
                    spending,
                    deadline,
                )
            ledger, reservation = held.ledger, held.identifier
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                cost = 0
                raise asyncio.TimeoutError
            held.dispatched = True
            response = await asyncio.wait_for(
                held.client.aio.models.generate_content(
                    model=model,
                    contents=contents,
                    config=held.config,
                ),
                timeout=remaining,
            )
            cost = rest_cost(response)
            result = schema.model_validate(self._parser(response.text))
            if check is not None:
                # Domain rejection is logged with this call. The validator's message can quote the
                # technician; only the fixed detail is returned, and the log line has no text.
                try:
                    checked = check(result)
                except (ValueError, ValidationError):
                    outcome = 'validation'
                    raise HTTPException(
                        502,
                        invalid_detail
                        or 'AI returned an unavailable or invalid result. Retry; no document or reading was verified.',
                    )
                if checked is not None:
                    result = checked
            outcome = 'ok'
            return result
        except SpendingError as error:
            outcome = 'budget_refused'
            error_fields = dict(status=error.status_code)
            raise
        except HTTPException:
            raise
        except (asyncio.TimeoutError, TimeoutError):
            outcome = 'timeout'
            raise HTTPException(
                504, 'AI generation timed out. Retry; no document or reading was verified.'
            )
        except genai_errors.APIError as error:
            # An HTTP error reply proves generation failed. A transport failure or a
            # missing response is different and retains its complete reservation.
            if type(error.code) is int and 400 <= error.code < 600:
                cost = 0
            outcome = type(error).__name__
            error_fields = dict(provider_status=error.status, provider_code=error.code)
            raise HTTPException(
                502,
                'AI returned an unavailable or invalid result. Retry; no document or reading was verified.',
            )
        except Exception as error:
            # Provider messages can echo the prompt; record only the class and status.
            outcome = type(error).__name__
            error_fields = dict(
                provider_status=getattr(error, 'status', None),
                provider_code=getattr(error, 'code', None),
            )
            raise HTTPException(
                502,
                'AI returned an unavailable or invalid result. Retry; no document or reading was verified.',
            )
        finally:
            if reservation:
                # Cancellation or a lost provider response is not proof of zero billing.
                # If settlement fails, the durable reservation continues to count in full.
                with anyio.CancelScope(shield=True):
                    try:
                        await self.within(deadline, ledger.settle, reservation, cost)
                    except Exception as error:
                        self._log(
                            'AI spending settlement failed',
                            logging.ERROR,
                            operation=operation,
                            model=model,
                            outcome=type(error).__name__,
                            reservation_id=reservation,
                            company_id=ledger.company_id,
                        )
            self._log(
                'Company AI request refused' if outcome == 'budget_refused' else 'Vertex AI call',
                logging.INFO if outcome in ('ok', 'budget_refused') else logging.ERROR,
                model=model,
                operation=operation,
                elapsed_ms=round((time.monotonic() - started) * 1000),
                outcome=outcome,
                inspection_id=inspection_id,
                **error_fields,
            )

    def rest_deadline(self, operation):
        @wraps(operation)
        async def bounded(*args, **kwargs):
            try:
                return await asyncio.wait_for(operation(*args, **kwargs), self._deadline_seconds())
            except asyncio.TimeoutError:
                raise HTTPException(
                    504,
                    'The request timed out. Your draft is preserved; retry. No document or reading was verified.',
                )

        return bounded
