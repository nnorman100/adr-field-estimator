"""Authenticated workspace administration. Invitations and the temporary-password change do not require membership."""

import json
import logging

from fastapi import Depends, HTTPException, Query, Request, Response, Security

try:
    from .workspaces import (
        CompanyCreate,
        OwnerLogin,
        PasswordChange,
        ProfileUpdate,
        StatusUpdate,
        InviteCreate,
        MemberUpdate,
        CoordinationUpdate,
        CustomerUpdate,
        customer_view,
        ArchiveRequest,
        ClaimUpdate,
        PASSWORD_CHANGE_REQUIRED,
    )
    from .delivery import read_delivery, resend_delivery
    from . import ai_features
    from .monitoring_store import WatchAction, ReminderRequest
    from .drying_watch import facts
    from .drying_summary import DryingSummary, validate_summary, summary_options
    from .prompts import DRYING_SUMMARY_INSTRUCTIONS
    from .cloud_log import event
    from .insights import Insights, JobSummary, validate_summary as validate_insight, sentences
    from .ai_usage import company_usage
    from .outcomes import JobClose
    from .retention import Retention, RetentionUpdate, retention_enabled
    from .prompts import JOB_SUMMARY_INSTRUCTIONS
except ImportError:
    from workspaces import (
        CompanyCreate,
        OwnerLogin,
        PasswordChange,
        ProfileUpdate,
        StatusUpdate,
        InviteCreate,
        MemberUpdate,
        CoordinationUpdate,
        CustomerUpdate,
        customer_view,
        ArchiveRequest,
        ClaimUpdate,
        PASSWORD_CHANGE_REQUIRED,
    )
    from delivery import read_delivery, resend_delivery
    import ai_features
    from monitoring_store import WatchAction, ReminderRequest
    from drying_watch import facts
    from drying_summary import DryingSummary, validate_summary, summary_options
    from prompts import DRYING_SUMMARY_INSTRUCTIONS
    from cloud_log import event
    from insights import Insights, JobSummary, validate_summary as validate_insight, sentences
    from ai_usage import company_usage
    from outcomes import JobClose
    from retention import Retention, RetentionUpdate, retention_enabled
    from prompts import JOB_SUMMARY_INSTRUCTIONS


OWNER_LOGIN_FAILED = 'The owner login could not be created. Try again or contact support.'
PASSWORD_CHANGE_FAILED = 'Your password could not be changed. Try again.'
PRIVATE = {'Cache-Control': 'private, no-store'}


async def failure_for(request: Request):
    """The 503 message for an unexpected Firebase or database failure on this request, from identity
    through the final write; None keeps the generic message. Refusals keep their own messages."""
    if request.method != 'POST':
        return None
    path = getattr(request.scope.get('route'), 'path', None)
    if path == '/api/account/password':
        return PASSWORD_CHANGE_FAILED
    if path == '/api/admin/companies/{company_id}/owner-login':
        return OWNER_LOGIN_FAILED
    if path == '/api/admin/companies':
        try:
            body = await request.json()
        except ValueError:
            return None
        if isinstance(body, dict) and body.get('owner_password') is not None:
            return OWNER_LOGIN_FAILED
    return None


def workspace_protocol(request):
    """Same rule as main.workspace_client. Imported at call time so this module can load with main."""
    try:
        from . import main as backend_main
    except ImportError:
        import main as backend_main
    if backend_main.WORKSPACES_ENABLED and request.headers.get('X-ADR-Workspace-Protocol') != '1':
        raise HTTPException(
            409, 'Update the app before generating or opening company-branded documents.'
        )


def register_workspace_routes(app, identity, get_store, stored, live, account):
    def workspace(store):
        return store.workspaces

    # Administration and access changes always repeat the revoked/disabled-user lookup.
    live_identity = Security(identity, scopes=live)
    # The temporary-password change is the one route a locked account can use.
    live_account = Security(account, scopes=live)
    failure_message = Depends(failure_for)

    def ai_store(store, feature):
        if not ai_features.enabled(feature) or not getattr(store, 'workspaces', None):
            raise HTTPException(404, 'This AI feature is not enabled.')
        return store

    @app.get('/api/jobs/{job_id}/insight')
    async def job_insight(
        job_id: str, facts_only: bool = False, claims=live_identity, store=Depends(get_store)
    ):
        try:
            from . import main as bm
        except ImportError:
            import main as bm
        insight = Insights(ai_store(store, 'job_summary'))
        current = await stored(insight.view, claims['uid'], job_id)
        event('Job insight read', operation='job_summary', cache_hit=bool(current['narrative']))
        if facts_only or current['narrative']:
            return current
        await stored(store.quota, claims['uid'], 'job_summary', 6)
        pack = {
            k: v for k, v in current['facts'].items() if k not in ('customer', 'address', 'rooms')
        }
        result = await bm.generate(
            JobSummary,
            JOB_SUMMARY_INSTRUCTIONS
            + '\n'
            + json.dumps(dict(facts=pack, topics=list(sentences(pack)))),
            bm.AUDIT_MODEL,
            'job_summary',
            current['job_id'],
            thinking_level='LOW',
            timeout=25,
        )
        try:
            validate_insight(result, current['facts'])
        except ValueError:
            event('Vertex AI call', logging.ERROR, operation='job_summary', outcome='invalid')
            raise HTTPException(502, 'Could not write the summary. Retry.') from None
        return await stored(insight.save, claims['uid'], job_id, current['facts_hash'], result)

    @app.get('/api/admin/companies/{company_id}/jobs/{job_id}/insight')
    async def support_insight(
        company_id: str, job_id: str, claims=live_identity, store=Depends(get_store)
    ):
        await stored(workspace(store).support_company, claims['uid'], company_id)
        return await stored(
            Insights(ai_store(store, 'job_summary')).view, claims['uid'], job_id, company_id
        )

    @app.get('/api/companies/{company_id}/ai-usage')
    async def ai_usage(company_id: str, claims=live_identity, store=Depends(get_store)):
        return await stored(company_usage, ai_store(store, 'ai_usage'), claims['uid'], company_id)

    @app.get('/api/admin/companies/{company_id}/ai-usage')
    async def support_ai_usage(company_id: str, claims=live_identity, store=Depends(get_store)):
        await stored(workspace(store).support_company, claims['uid'], company_id)
        return await stored(
            company_usage, ai_store(store, 'ai_usage'), claims['uid'], company_id, True
        )

    def monitoring(store):
        if not ai_features.enabled('drying_watch') or not getattr(store, 'workspaces', None):
            raise HTTPException(404, 'Drying watch is not enabled.')
        return workspace(store).monitoring

    @app.get('/api/companies/{company_id}/drying-watch')
    async def company_watch(
        company_id: str,
        cursor: str | None = Query(default=None, max_length=80),
        claims=live_identity,
        store=Depends(get_store),
    ):
        watch = monitoring(store)
        actor = await stored(workspace(store).company_actor, claims['uid'], company_id)
        if actor['role'] not in ('owner', 'office'):
            raise HTTPException(403, 'Use My drying jobs for estimator access.')
        return await stored(watch.listing, claims['uid'], company_id, False, cursor)

    @app.get('/api/jobs/drying-watch')
    async def my_watch(
        cursor: str | None = Query(default=None, max_length=80),
        claims=live_identity,
        store=Depends(get_store),
    ):
        return await stored(monitoring(store).listing, claims['uid'], None, False, cursor)

    @app.get('/api/admin/companies/{company_id}/drying-watch')
    async def support_watch(
        company_id: str,
        cursor: str | None = Query(default=None, max_length=80),
        claims=live_identity,
        store=Depends(get_store),
    ):
        await stored(workspace(store).support_company, claims['uid'], company_id)
        return await stored(monitoring(store).listing, claims['uid'], company_id, True, cursor)

    @app.get('/api/jobs/{inspection_id}/drying-watch')
    async def job_watch(inspection_id: str, claims=live_identity, store=Depends(get_store)):
        return await stored(monitoring(store).view, claims['uid'], inspection_id)

    @app.post('/api/jobs/{inspection_id}/drying-watch/summary')
    async def drying_summary(inspection_id: str, claims=live_identity, store=Depends(get_store)):
        try:
            from . import main as bm
        except ImportError:
            import main as bm
        watch = monitoring(store)
        current = await stored(watch.view, claims['uid'], inspection_id)
        if current.get('summary'):
            return current
        await stored(store.quota, claims['uid'], 'drying_summary', 6)
        pack = facts(current)
        result = await bm.generate(
            DryingSummary,
            DRYING_SUMMARY_INSTRUCTIONS
            + '\n'
            + json.dumps(dict(facts=pack, options=summary_options(pack))),
            bm.AUDIT_MODEL,
            'drying_watch',
            inspection_id,
            thinking_level='LOW',
            timeout=25,
        )
        try:
            validate_summary(result, pack)
        except ValueError:
            event(
                'Drying summary rejected',
                logging.ERROR,
                operation='drying_watch',
                outcome='invalid',
                watch_status=current['status'],
            )
            raise HTTPException(502, 'Could not write the summary. Retry.') from None
        await stored(
            watch.save_summary, claims['uid'], inspection_id, current['facts_hash'], result
        )
        return await stored(watch.view, claims['uid'], inspection_id)

    @app.post('/api/jobs/{inspection_id}/drying-watch/state')
    async def drying_state(
        inspection_id: str, req: WatchAction, claims=live_identity, store=Depends(get_store)
    ):
        watch = monitoring(store)
        await stored(watch.access, claims['uid'], inspection_id)
        await stored(store.quota, claims['uid'], 'drying_action', 10)
        await stored(watch.change, claims['uid'], inspection_id, req)
        return await stored(watch.view, claims['uid'], inspection_id)

    @app.post('/api/jobs/{inspection_id}/drying-watch/remind')
    async def drying_remind(
        inspection_id: str, req: ReminderRequest, claims=live_identity, store=Depends(get_store)
    ):
        watch = monitoring(store)
        await stored(watch.access, claims['uid'], inspection_id, 'coordination')
        await stored(store.quota, claims['uid'], 'drying_reminder', 6)
        return await stored(watch.remind, claims['uid'], inspection_id, req)

    def outcomes(store):
        if not ai_features.enabled('estimate_assist') or not getattr(store, 'workspaces', None):
            raise HTTPException(404, 'Estimate assist is not enabled.')
        return store.outcomes

    @app.get('/api/jobs/{inspection_id}/outcome')
    async def job_outcome(
        inspection_id: str, response: Response, claims=live_identity, store=Depends(get_store)
    ):
        response.headers.update(PRIVATE)
        return await stored(outcomes(store).view, claims['uid'], inspection_id)

    @app.post('/api/jobs/{inspection_id}/close')
    async def close_job(
        inspection_id: str,
        req: JobClose,
        response: Response,
        claims=live_identity,
        store=Depends(get_store),
    ):
        response.headers.update(PRIVATE)
        closing = outcomes(store)
        await stored(store.quota, claims['uid'], 'draft', 60)
        return await stored(closing.close, claims['uid'], inspection_id, req)

    @app.get('/api/companies/{company_id}/estimate-accuracy')
    async def estimate_accuracy(
        company_id: str, response: Response, claims=live_identity, store=Depends(get_store)
    ):
        response.headers.update(PRIVATE)
        accuracy = outcomes(store)
        await stored(store.quota, claims['uid'], 'price_calculate')
        return await stored(accuracy.accuracy, claims['uid'], company_id)

    @app.get('/api/access')
    async def access(claims=Depends(identity), store=Depends(get_store)):
        actor = await stored(workspace(store).principal, claims['uid'])
        if actor['password_change_required']:
            raise HTTPException(403, PASSWORD_CHANGE_REQUIRED)
        invitations = await stored(workspace(store).pending, claims)
        try:
            from .price_books import price_books_enabled
        except ImportError:
            from price_books import price_books_enabled
        return dict(
            **actor,
            email=claims['email'],
            project='alert-disaster-field-2026',
            workspaces_enabled=True,
            price_books_enabled=bool(price_books_enabled()),
            retention_enabled=retention_enabled(),
            **await stored(workspace(store).prices.session_view, actor),
            # The shared sender is near Gmail's daily limit; only owners are told.
            email_notice=actor['role'] == 'owner' and await stored(workspace(store).email_notice),
            invitations=[
                {
                    'invitation_id': i['invitation_id'],
                    'role': i['role'],
                    'company_id': i['company_id'],
                }
                for i in invitations
            ],
        )

    @app.get('/api/admin/companies')
    async def companies(claims=live_identity, store=Depends(get_store)):
        return {'companies': await stored(workspace(store).companies, claims['uid'])}

    @app.post('/api/admin/companies')
    async def create_company(
        req: CompanyCreate,
        claims=live_identity,
        store=Depends(get_store),
        failure=failure_message,
    ):
        await stored(store.quota, claims['uid'], 'admin', 10, failure=failure)
        if req.owner_password is not None:
            return await stored(
                workspace(store).owner_login,
                claims['uid'],
                None,
                req.owner_email,
                req.owner_password.get_secret_value(),
                None,
                req.name,
                failure=failure,
            )
        company, invitation = await stored(
            workspace(store).create_company, claims['uid'], req.name, req.owner_email
        )
        invitation = await stored(
            workspace(store).deliver, claims['uid'], invitation['invitation_id']
        )
        return {'company': company, 'invitation': invitation}

    @app.post('/api/admin/companies/{company_id}/owner-login')
    async def owner_login(
        company_id: str,
        req: OwnerLogin,
        claims=live_identity,
        store=Depends(get_store),
        failure=failure_message,
    ):
        await stored(store.quota, claims['uid'], 'admin', 10, failure=failure)
        return await stored(
            workspace(store).owner_login,
            claims['uid'],
            company_id,
            req.email,
            req.password.get_secret_value(),
            req.expected_version,
            failure=failure,
        )

    @app.post('/api/account/password')
    async def change_password(
        req: PasswordChange, claims=live_account, store=Depends(get_store), failure=failure_message
    ):
        await stored(store.quota, claims['uid'], 'account', 10, failure=failure)
        return await stored(
            workspace(store).change_password,
            claims,
            req.password.get_secret_value(),
            failure=failure,
        )

    @app.get('/api/companies/{company_id}')
    async def company(company_id: str, claims=live_identity, store=Depends(get_store)):
        return await stored(workspace(store).company, claims['uid'], company_id)

    @app.put('/api/companies/{company_id}')
    async def profile(
        company_id: str, req: ProfileUpdate, claims=live_identity, store=Depends(get_store)
    ):
        if req.profile.additional_work_rate is not None:
            try:
                from .main import extras_enabled
            except ImportError:
                from main import extras_enabled
            extras_enabled()
        await stored(store.quota, claims['uid'], 'team', 20)
        return await stored(workspace(store).update_company, claims['uid'], company_id, req)

    @app.put('/api/admin/companies/{company_id}/status')
    async def status(
        company_id: str, req: StatusUpdate, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'admin', 10)
        return await stored(workspace(store).update_company, claims['uid'], company_id, req)

    @app.get('/api/companies/{company_id}/team')
    async def team(company_id: str, claims=live_identity, store=Depends(get_store)):
        return {'members': await stored(workspace(store).team, claims['uid'], company_id)}

    @app.get('/api/companies/{company_id}/team/{member_uid}/signing-links')
    async def member_signing_links(
        company_id: str, member_uid: str, claims=live_identity, store=Depends(get_store)
    ):
        return {
            'links': await stored(
                workspace(store).pending_signing_links, claims['uid'], company_id, member_uid
            )
        }

    @app.put('/api/companies/{company_id}/team/{member_uid}')
    async def member(
        company_id: str,
        member_uid: str,
        req: MemberUpdate,
        claims=live_identity,
        store=Depends(get_store),
    ):
        await stored(store.quota, claims['uid'], 'team', 20)
        return await stored(
            workspace(store).update_member, claims['uid'], company_id, member_uid, req
        )

    def retention(store):
        if not getattr(store, 'workspaces', None):
            raise HTTPException(404, 'Record retention needs company workspaces.')
        return Retention(store.workspaces, store.bucket)

    @app.get('/api/companies/{company_id}/retention')
    async def retention_view(company_id: str, claims=live_identity, store=Depends(get_store)):
        return await stored(retention(store).view, claims['uid'], company_id)

    @app.put('/api/companies/{company_id}/retention')
    async def retention_update(
        company_id: str, req: RetentionUpdate, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'team', 20)
        return await stored(retention(store).update, claims['uid'], company_id, req)

    @app.post('/api/companies/{company_id}/retention/run')
    async def retention_run(company_id: str, claims=Depends(identity), store=Depends(get_store)):
        """Any active member's app asks once per session; the sweep runs at most daily."""
        return await stored(retention(store).tick, claims['uid'], company_id)

    @app.get('/api/companies/{company_id}/invitations')
    async def invitations(company_id: str, claims=live_identity, store=Depends(get_store)):
        return {
            'invitations': await stored(workspace(store).invitations, claims['uid'], company_id)
        }

    @app.post('/api/companies/{company_id}/invitations/clear')
    async def clear_invitations(company_id: str, claims=live_identity, store=Depends(get_store)):
        await stored(store.quota, claims['uid'], 'team', 20)
        result = await stored(workspace(store).clear_invitations, claims['uid'], company_id)
        # Count only. The allowlist drops ids, addresses and anything else this call could add.
        event(
            'Invitations cleared',
            operation='invitation_clear',
            outcome='cleared',
            cleared=result['cleared'],
        )
        return result

    @app.post('/api/companies/{company_id}/invitations')
    async def invite(
        company_id: str, req: InviteCreate, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'team', 20)
        invitation = await stored(
            workspace(store).invite, claims['uid'], company_id, req.email, req.role
        )
        return await stored(workspace(store).deliver, claims['uid'], invitation['invitation_id'])

    @app.post('/api/companies/{company_id}/invitations/{invitation_id}/{action}')
    async def invitation_action(
        company_id: str,
        invitation_id: str,
        action: str,
        claims=live_identity,
        store=Depends(get_store),
    ):
        await stored(store.quota, claims['uid'], 'team', 20)
        invitation = await stored(
            workspace(store).invitation_action, claims['uid'], company_id, invitation_id, action
        )
        if action == 'resend':
            invitation = await stored(workspace(store).deliver, claims['uid'], invitation_id)
        return invitation

    @app.get('/api/invitations/{invitation_id}')
    async def invitation(invitation_id: str, claims=Depends(identity), store=Depends(get_store)):
        return await stored(workspace(store).invitation, claims, invitation_id)

    @app.post('/api/invitations/{invitation_id}/accept')
    async def accept(invitation_id: str, claims=live_identity, store=Depends(get_store)):
        await stored(store.quota, claims['uid'], 'team', 20)
        return await stored(workspace(store).accept, claims, invitation_id)

    @app.get('/api/jobs/{inspection_id}/coordination')
    async def get_coordination(
        inspection_id: str, claims=Depends(identity), store=Depends(get_store)
    ):
        record = await stored(store.get_inspection, claims['uid'], inspection_id)
        job, actor = await stored(workspace(store).job_access, claims['uid'], record)
        return job if 'coordination' in actor['capabilities'] else customer_view(job)

    @app.put('/api/jobs/{inspection_id}/coordination')
    async def coordination(
        inspection_id: str, req: CoordinationUpdate, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'draft', 60)
        return await stored(workspace(store).coordination, claims['uid'], inspection_id, req)

    @app.put('/api/jobs/{inspection_id}/customer')
    async def customer(
        inspection_id: str, req: CustomerUpdate, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'draft', 60)
        return await stored(workspace(store).customer, claims['uid'], inspection_id, req)

    @app.post('/api/jobs/{inspection_id}/archive')
    async def archive_job(
        inspection_id: str, req: ArchiveRequest, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'draft', 60)
        return await stored(workspace(store).archive_job, claims['uid'], inspection_id, req)

    @app.post('/api/jobs/{inspection_id}/restore')
    async def restore_job(
        inspection_id: str, req: ArchiveRequest, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'draft', 60)
        return await stored(workspace(store).restore_job, claims['uid'], inspection_id, req)

    @app.get('/api/archived-jobs')
    async def archived_jobs(claims=live_identity, store=Depends(get_store)):
        return {'jobs': await stored(workspace(store).archived_jobs, claims['uid'])}

    # Superadmin support actions for a company whose owner cannot sign in, such as a suspended
    # test company: archive or restore an unsigned draft, each audited.
    @app.get('/api/admin/companies/{company_id}/archived-jobs')
    async def support_archived_jobs(
        company_id: str, claims=live_identity, store=Depends(get_store)
    ):
        jobs = await stored(workspace(store).archived_jobs, claims['uid'], company_id)
        return {'jobs': jobs}

    @app.post('/api/admin/companies/{company_id}/jobs/{inspection_id}/archive')
    async def support_archive_job(
        company_id: str,
        inspection_id: str,
        req: ArchiveRequest,
        claims=live_identity,
        store=Depends(get_store),
    ):
        await stored(store.quota, claims['uid'], 'admin', 10)
        return await stored(
            workspace(store).archive_job, claims['uid'], inspection_id, req, company_id
        )

    @app.post('/api/admin/companies/{company_id}/jobs/{inspection_id}/restore')
    async def support_restore_job(
        company_id: str,
        inspection_id: str,
        req: ArchiveRequest,
        claims=live_identity,
        store=Depends(get_store),
    ):
        await stored(store.quota, claims['uid'], 'admin', 10)
        return await stored(
            workspace(store).restore_job, claims['uid'], inspection_id, req, company_id
        )

    @app.get('/api/jobs/{inspection_id}/claim')
    async def get_claim(inspection_id: str, claims=Depends(identity), store=Depends(get_store)):
        return await stored(workspace(store).claim, claims['uid'], inspection_id)

    @app.put('/api/jobs/{inspection_id}/claim')
    async def claim(
        inspection_id: str, req: ClaimUpdate, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'draft', 60)
        return await stored(workspace(store).update_claim, claims['uid'], inspection_id, req)

    @app.get('/api/jobs/{inspection_id}/delivery')
    async def job_delivery(
        inspection_id: str, request: Request, claims=Depends(identity), store=Depends(get_store)
    ):
        workspace_protocol(request)
        return await stored(read_delivery, store, claims['uid'], inspection_id)

    @app.post('/api/jobs/{inspection_id}/delivery/resend')
    async def job_delivery_resend(
        inspection_id: str, request: Request, claims=live_identity, store=Depends(get_store)
    ):
        workspace_protocol(request)
        await stored(store.quota, claims['uid'], 'delivery', 10)
        origin = request.headers.get('origin')
        return await stored(resend_delivery, store, claims['uid'], inspection_id, origin)
