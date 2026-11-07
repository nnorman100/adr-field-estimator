"""Emulator concurrency helpers and the company AI reservation case."""

from concurrent.futures import ThreadPoolExecutor
import pytest


def concurrently(calls):
    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [pool.submit(call) for call in calls]
        return [future.exception() or future.result() for future in futures]


def company_spending_reservations(instances, concurrently, outcomes):
    from fastapi import HTTPException
    from backend.ai_spending import CompanySpending, DEFAULT_CAP

    stores = instances()
    ledgers = [CompanySpending(store, 'adr') for store in stores]
    results = concurrently(
        [
            lambda i=i: ledgers[i % 2].reserve('audit' if i % 2 else 'ocr', DEFAULT_CAP // 2)
            for i in range(4)
        ]
    )
    admitted = outcomes(results, refused=HTTPException)
    assert len(admitted) <= 2
    for result in results:
        if isinstance(result, HTTPException):
            assert result.status_code == 429
    assert ledgers[0].summary()['reserved_microusd'] == len(admitted) * (DEFAULT_CAP // 2)
    while len(admitted) < 2:
        admitted.append(ledgers[0].reserve('scope', DEFAULT_CAP // 2))
    # A fresh process/client cannot reclaim a crashed worker's allowance.
    restarted = CompanySpending(instances(count=1)[0], 'adr')
    with pytest.raises(HTTPException) as error:
        restarted.reserve('transcribe', 1)
    assert error.value.status_code == 429
    results = concurrently([lambda i=i: ledgers[i % 2].settle(admitted[0], 500) for i in range(4)])
    outcomes(results, refused=HTTPException)
    restarted.settle(admitted[0], 500)
    summary = restarted.summary()
    assert summary['spent_microusd'] == 500
    assert summary['reserved_microusd'] == DEFAULT_CAP // 2
    assert CompanySpending(stores[0], 'other').reserve('audit', DEFAULT_CAP)
