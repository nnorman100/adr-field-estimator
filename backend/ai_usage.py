"""Counts only, from active company members' existing per-user windows."""

from google.cloud import firestore


def company_usage(store, uid, company_id, support=False):
    w = store.workspaces
    if support:
        w.support_company(uid, company_id)
    else:
        actor = w.company_actor(uid)
        if actor['company_id'] != company_id:
            raise LookupError('Company not found.')
        w.company_actor(uid, company_id, manage=True)
    members = [
        s.to_dict()
        for s in w.db.collection('_memberships')
        .where(filter=firestore.FieldFilter('company_id', '==', company_id))
        .stream()
        if s.to_dict().get('status') == 'active'
    ]
    totals = {}
    for member in members:
        for operation, counts in store.usage(member['uid']).items():
            total = totals.setdefault(
                operation, dict(used=0, limit=0, remaining=0, per_user_limit=counts['limit'])
            )
            for field in ('used', 'limit', 'remaining'):
                total[field] += counts[field]
    if support:
        w.support_audit(uid, company_id, 'view_ai_usage', 'ai-usage')
    else:
        w.company_actor(uid, company_id, manage=True)
    return dict(operations=totals, members=len(members))
