"""Authenticated workspace administration. Invitations and the temporary-password change do not require membership."""

import json
import logging

from fastapi import Depends, HTTPException, Query, Request, Security

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
        ClaimUpdate,
        PASSWORD_CHANGE_REQUIRED,
    )
    from .delivery import read_delivery, resend_delivery
    from . import ai_features
    from .monitoring_store import WatchAction, ReminderRequest
    from .drying_watch import facts
    from .drying_summary import DryingSummary, validate_summary
    from .prompts import DRYING_SUMMARY_INSTRUCTIONS
    from .cloud_log import event
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
        ClaimUpdate,
        PASSWORD_CHANGE_REQUIRED,
    )
    from delivery import read_delivery, resend_delivery
    import ai_features
    from monitoring_store import WatchAction, ReminderRequest
    from drying_watch import facts
    from drying_summary import DryingSummary, validate_summary
    from prompts import DRYING_SUMMARY_INSTRUCTIONS
    from cloud_log import event


OWNER_LOGIN_FAILED = 'The owner login could not be created. Try again or contact support.'
PASSWORD_CHANGE_FAILED = 'Your password could not be changed. Try again.'


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
            DRYING_SUMMARY_INSTRUCTIONS + '\n' + json.dumps(pack),
            bm.AUDIT_MODEL,
            'drying_watch',
            inspection_id,
            thinking_level='LOW',
            timeout=25,
        )
        try:
            text = validate_summary(result, pack)
        except ValueError:
            event(
                'Drying summary rejected',
                logging.ERROR,
                operation='drying_watch',
                outcome='invalid',
                watch_status=current['status'],
            )
            raise HTTPException(502, 'Could not write the summary. Retry.') from None
        await stored(watch.save_summary, claims['uid'], inspection_id, current['facts_hash'], text)
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

    @app.get('/api/access')
    async def access(claims=Depends(identity), store=Depends(get_store)):
        actor = await stored(workspace(store).principal, claims['uid'])
        if actor['password_change_required']:
            raise HTTPException(403, PASSWORD_CHANGE_REQUIRED)
        invitations = await stored(workspace(store).pending, claims)
        return dict(
            **actor,
            email=claims['email'],
            project='alert-disaster-field-2026',
            workspaces_enabled=True,
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

    @app.get('/api/companies/{company_id}/invitations')
    async def invitations(company_id: str, claims=live_identity, store=Depends(get_store)):
        return {
            'invitations': await stored(workspace(store).invitations, claims['uid'], company_id)
        }

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
        job, _ = await stored(workspace(store).job_access, claims['uid'], record)
        return job

    @app.put('/api/jobs/{inspection_id}/coordination')
    async def coordination(
        inspection_id: str, req: CoordinationUpdate, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'draft', 60)
        return await stored(workspace(store).coordination, claims['uid'], inspection_id, req)

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
