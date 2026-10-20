"""Authenticated workspace administration. Invitations and the temporary-password change do not require membership."""

from fastapi import Depends, HTTPException, Security

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
        PASSWORD_CHANGE_REQUIRED,
    )
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
        PASSWORD_CHANGE_REQUIRED,
    )


def register_workspace_routes(app, identity, get_store, stored, live, account):
    def workspace(store):
        return store.workspaces

    # Administration and access changes always repeat the revoked/disabled-user lookup.
    live_identity = Security(identity, scopes=live)
    # The temporary-password change is the one route a locked account can use.
    live_account = Security(account, scopes=live)

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
    async def create_company(req: CompanyCreate, claims=live_identity, store=Depends(get_store)):
        await stored(store.quota, claims['uid'], 'admin', 10)
        if req.owner_password is not None:
            return await stored(
                workspace(store).owner_login,
                claims['uid'],
                None,
                req.owner_email,
                req.owner_password.get_secret_value(),
                None,
                req.name,
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
        company_id: str, req: OwnerLogin, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'admin', 10)
        return await stored(
            workspace(store).owner_login,
            claims['uid'],
            company_id,
            req.email,
            req.password.get_secret_value(),
            req.expected_version,
        )

    @app.post('/api/account/password')
    async def change_password(req: PasswordChange, claims=live_account, store=Depends(get_store)):
        await stored(store.quota, claims['uid'], 'account', 10)
        return await stored(
            workspace(store).change_password, claims, req.password.get_secret_value()
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
