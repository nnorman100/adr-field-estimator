"""Firebase Auth export records for firebase auth:import.

Mirrors firebase-tools 15.34.0 lib/accountExporter.js, then refuses a password
account whose hash would be missing or dropped. A backup without hashes cannot
be used to sign in.
"""

KEYS = (
    'localId',
    'email',
    'emailVerified',
    'passwordHash',
    'salt',
    'displayName',
    'photoUrl',
    'lastLoginAt',
    'createdAt',
    'phoneNumber',
    'disabled',
    'customAttributes',
    'mfaInfo',
)
RENAMED = {'lastLoginAt': 'lastSignedInAt'}
PROVIDER_KEYS = ('providerId', 'rawId', 'email', 'displayName', 'photoUrl')
PROVIDERS = frozenset(
    {
        'google.com',
        'facebook.com',
        'twitter.com',
        'github.com',
        'apple.com',
        'microsoft.com',
        'gc.apple.com',
        'playgames.google.com',
        'linkedin.com',
        'yahoo.com',
    }
)


class ExportError(Exception):
    """The page cannot be restored with passwords. The message stays fixed."""


def _normalize_base64(value):
    return value.replace('_', '/').replace('-', '+')


def to_import_record(account):
    user = dict(account)
    # firebase-tools keeps password material only for hash version 0 (SCRYPT).
    if user.get('passwordHash') and user.get('version') != 0:
        user.pop('passwordHash', None)
        user.pop('salt', None)
    record = {}
    for key in KEYS:
        if key in user:
            record[RENAMED.get(key, key)] = user[key]
    if record.get('passwordHash'):
        if not isinstance(record['passwordHash'], str):
            raise ExportError
        record['passwordHash'] = _normalize_base64(record['passwordHash'])
    if record.get('salt'):
        if not isinstance(record['salt'], str):
            raise ExportError
        record['salt'] = _normalize_base64(record['salt'])
    providers = user.get('providerUserInfo')
    if providers:
        if not isinstance(providers, list):
            raise ExportError
        kept = []
        for info in providers:
            if not isinstance(info, dict):
                raise ExportError
            if info.get('providerId') in PROVIDERS:
                kept.append({key: info[key] for key in PROVIDER_KEYS if key in info})
        record['providerUserInfo'] = kept
    return record


def records_from_accounts(accounts):
    if not isinstance(accounts, list):
        raise ExportError
    records = []
    for account in accounts:
        if not isinstance(account, dict) or not isinstance(account.get('localId'), str):
            raise ExportError
        if not account['localId']:
            raise ExportError
        # passwordUpdatedAt without a hash means the caller cannot read hashes.
        if account.get('passwordUpdatedAt') and not account.get('passwordHash'):
            raise ExportError
        record = to_import_record(account)
        if account.get('passwordUpdatedAt') and not record.get('passwordHash'):
            raise ExportError
        records.append(record)
    return records
