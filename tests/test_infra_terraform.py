"""Guards for the DryScope Terraform under infra/dryscope.

Static checks, no Terraform binary needed. They hold the rules for roots that will be applied
to the real project: the new roots only add resources in alert-disaster-field-2026 / us-central1,
never reference or remove an existing one, keep every stateful resource protected, and grant
only a short list of narrow roles. `infra/dryscope/scripts/check.sh` runs the mocked
`terraform test` suites and `terraform validate`.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
INFRA = ROOT / 'infra' / 'dryscope'
ROOTS = ['data', 'app']
ENVS = ['test', 'live']

# Legacy resources in the old region and the other apps in the project.
LEGACY_NAMES = [
    'us-west',
    'alert-disaster-field-estimator',
    '"alert-disaster-field-2026-evidence"',
    '(default)',
    'adr-runtime',
    'adr-builder',
    'mitigation-project',
    'alert-disaster-live',
    'dryscope-vault-backup',
]

# Every role the configuration may grant. Anything else needs a reviewed addition here.
ALLOWED_ROLES = {
    'roles/aiplatform.user',
    'roles/artifactregistry.writer',
    'roles/cloudsql.client',
    'roles/cloudsql.instanceUser',
    'roles/datastore.user',
    'roles/iam.serviceAccountUser',
    'roles/iam.workloadIdentityUser',
    'roles/run.developer',
    'roles/run.invoker',
    'roles/secretmanager.secretAccessor',
    'roles/storage.objectCreator',
    'roles/storage.objectViewer',
}

# Stateful resources that must never be destroyed by a plan.
PROTECTED_TYPES = {
    'google_sql_database_instance',
    'google_firestore_database',
    'google_storage_bucket',
    'google_secret_manager_secret',
    'google_artifact_registry_repository',
    'google_cloud_run_v2_service',
}


def strip_comments(text):
    """Remove #, // and /* */ comments that sit outside double-quoted strings."""
    out = []
    i, n, in_str = 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
            out.append(c)
        elif c == '#' or text.startswith('//', i):
            while i < n and text[i] != '\n':
                i += 1
            continue
        elif text.startswith('/*', i):
            end = text.find('*/', i + 2)
            i = n if end < 0 else end + 1
        else:
            out.append(c)
        i += 1
    return ''.join(out)


def blocks(text, header_re):
    """Yield (match, body) for each block whose opening line matches header_re."""
    for m in re.finditer(header_re + r'\s*\{', text):
        depth, i, in_str = 1, m.end(), False
        while i < len(text) and depth:
            c = text[i]
            if in_str:
                if c == '\\':
                    i += 1
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
            i += 1
        yield m, text[m.end() : i - 1]


def files(*suffixes, skip_tests=False):
    found = []
    for path in sorted(INFRA.rglob('*')):
        if '.terraform' in path.parts or not path.is_file() or path.suffix not in suffixes:
            continue
        if skip_tests and 'tests' in path.relative_to(INFRA).parts:
            continue
        found.append(path)
    return found


def code(path):
    return strip_comments(path.read_text(encoding='utf-8'))


def all_code(*suffixes, skip_tests=False):
    return '\n'.join(code(p) for p in files(*suffixes, skip_tests=skip_tests))


def resources(root=None):
    out = []
    for path in files('.tf'):
        if root and path.relative_to(INFRA).parts[0] != root:
            continue
        for m, body in blocks(code(path), r'resource\s+"([a-z0-9_]+)"\s+"([a-z0-9_]+)"'):
            out.append((m.group(1), m.group(2), body, path))
    return out


def tfvars(root, env):
    values = {}
    for line in code(INFRA / root / 'envs' / f'{env}.tfvars').splitlines():
        m = re.match(r'([a-z_]+)\s*=\s*(.+?)\s*$', line)  # top level only
        if m:
            values[m.group(1)] = m.group(2).strip('"')
    return values


def test_both_roots_have_both_environment_sets():
    for root in ROOTS:
        for env in ENVS:
            assert (INFRA / root / 'envs' / f'{env}.tfvars').is_file()
            assert (INFRA / root / 'envs' / f'backend-{env}.hcl').is_file()
        assert (INFRA / root / 'versions.tf').is_file()
        assert (INFRA / root / '.terraform.lock.hcl').is_file()
        assert 'hashicorp/google' in (INFRA / root / '.terraform.lock.hcl').read_text()


def test_environment_sets_target_only_the_new_project_and_region():
    for root in ROOTS:
        for env in ENVS:
            values = tfvars(root, env)
            assert values['project_id'] == 'alert-disaster-field-2026'
            assert values['region'] == 'us-central1'
            assert values['environment'] == env


def test_roots_keep_separate_state_per_environment():
    prefixes = []
    for root in ROOTS:
        assert re.search(r'backend\s+"gcs"\s*\{\s*\}', code(INFRA / root / 'versions.tf'))
        for env in ENVS:
            text = code(INFRA / root / 'envs' / f'backend-{env}.hcl')
            prefixes.append(re.search(r'prefix\s*=\s*"([^"]+)"', text).group(1))
    assert sorted(prefixes) == ['app/live', 'app/test', 'data/live', 'data/test']


def test_nothing_references_an_existing_us_west2_or_legacy_resource():
    text = all_code('.tf', '.tfvars', '.hcl', skip_tests=True)
    for name in LEGACY_NAMES:
        assert name not in text, f'{name} must not appear in the new roots'


def test_no_construct_that_adopts_or_destroys_existing_resources():
    text = all_code('.tf', skip_tests=True)
    forbidden = [
        r'^\s*import\s*\{',
        r'^\s*removed\s*\{',
        r'^\s*moved\s*\{',
        r'\bprovisioner\b',
        r'\blocal-exec\b',
        r'\bnull_resource\b',
        r'terraform_remote_state',
        r'create_before_destroy',
        r'\breplace_triggered_by\b',
    ]
    for pattern in forbidden:
        assert not re.search(pattern, text, re.M), pattern
    data_sources = set(re.findall(r'^\s*data\s+"([a-z0-9_]+)"', text, re.M))
    assert data_sources <= {'google_project'}, 'only the project number may be read'


def test_deletion_protection_is_never_switched_off():
    text = all_code('.tf', '.tfvars', skip_tests=True)
    for pattern in [
        r'deletion_protection\s*=\s*false',
        r'deletion_protection_enabled\s*=\s*false',
        r'force_destroy\s*=\s*true',
        r'prevent_destroy\s*=\s*false',
        r'DELETE_PROTECTION_DISABLED',
        r'deletion_policy\s*=\s*"DELETE"',
    ]:
        assert not re.search(pattern, text), pattern
    assert not re.search(r'variable\s+"[a-z_]*(deletion|destroy)[a-z_]*"', text)


def test_every_stateful_resource_is_protected():
    seen = {t: 0 for t in PROTECTED_TYPES}
    for rtype, name, body, path in resources():
        if rtype not in PROTECTED_TYPES:
            continue
        seen[rtype] += 1
        assert re.search(r'prevent_destroy\s*=\s*true', body), f'{rtype}.{name}'
    assert all(count >= 1 for count in seen.values()), seen


def test_stateful_resources_carry_their_native_protection():
    by_type = {}
    for rtype, name, body, path in resources():
        by_type.setdefault(rtype, []).append(body)
    (sql,) = by_type['google_sql_database_instance']
    assert re.search(r'^\s*deletion_protection\s*=\s*true', sql, re.M)
    assert re.search(r'deletion_protection_enabled\s*=\s*true', sql)
    assert re.search(r'point_in_time_recovery_enabled\s*=\s*true', sql)
    assert re.search(r'backup_configuration', sql) and re.search(r'enabled\s*=\s*true', sql)
    assert re.search(r'availability_type\s*=\s*"ZONAL"', sql)
    assert re.search(r'ssl_mode\s*=\s*"ENCRYPTED_ONLY"', sql)
    assert 'authorized_networks' not in sql
    (fs,) = by_type['google_firestore_database']
    assert 'DELETE_PROTECTION_ENABLED' in fs
    assert 'POINT_IN_TIME_RECOVERY_ENABLED' in fs
    assert re.search(r'deletion_policy\s*=\s*"ABANDON"', fs)
    (bucket,) = by_type['google_storage_bucket']
    assert re.search(r'uniform_bucket_level_access\s*=\s*true', bucket)
    assert re.search(r'public_access_prevention\s*=\s*"enforced"', bucket)
    assert re.search(r'force_destroy\s*=\s*false', bucket)
    assert re.search(r'versioning\s*\{\s*enabled\s*=\s*true', bucket)
    assert 'retention_policy' not in bucket and 'lifecycle_rule' not in bucket
    for service in by_type['google_cloud_run_v2_service']:
        assert re.search(r'deletion_protection\s*=\s*true', service)
    for body in by_type['google_sql_database'] + by_type['google_sql_user']:
        assert re.search(r'deletion_policy\s*=\s*"ABANDON"', body)


def test_only_additive_iam_with_the_reviewed_roles():
    text = all_code('.tf', skip_tests=True)
    for rtype in re.findall(r'^\s*resource\s+"([a-z0-9_]+)"', text, re.M):
        if 'iam' in rtype:
            assert rtype.endswith('_iam_member'), f'{rtype} replaces existing grants'
    assert not re.search(
        r'resource\s+"google_(project|folder|organization)(_iam_audit_config)?"', text
    )
    roles = set(re.findall(r'"(roles/[A-Za-z0-9_.]+)"', text))
    assert roles, 'no roles found'
    assert roles <= ALLOWED_ROLES, sorted(roles - ALLOWED_ROLES)


def test_project_level_data_grants_are_conditioned_on_this_environment():
    for rtype, name, body, path in resources('data'):
        if rtype != 'google_project_iam_member':
            continue
        if 'roles/aiplatform.user' in body:
            continue  # Vertex AI cannot be scoped; it is the one reviewed project-wide grant
        assert re.search(r'condition\s*\{', body), f'{name} must carry an IAM condition'


def test_public_access_is_only_cloud_run_invocation():
    for rtype, name, body, path in resources():
        if 'allUsers' in body or 'allAuthenticatedUsers' in body:
            assert rtype == 'google_cloud_run_v2_service_iam_member'
            assert 'roles/run.invoker' in body
    assert 'allAuthenticatedUsers' not in all_code('.tf')


def test_no_secret_values_keys_or_passwords_in_configuration():
    text = all_code('.tf', '.tfvars', '.hcl', skip_tests=True)
    for pattern in [
        r'google_secret_manager_secret_version',
        r'secret_data',
        r'google_service_account_key',
        r'private_key',
        r'\bpassword\s*=',
        r'BUILT_IN',
        r'-----BEGIN',
    ]:
        assert not re.search(pattern, text), pattern
    # An email address (alerts, owner) never sits in the repository's variable sets.
    for path in files('.tfvars', '.hcl', skip_tests=True):
        assert '@' not in code(path), path.name


def test_environment_variable_sets_keep_test_cheap_and_live_dedicated():
    assert tfvars('data', 'live')['sql_tier'].startswith('db-custom-')
    assert not tfvars('data', 'test')['sql_tier'].startswith('db-custom-4')
    for key in ('api_scaling', 'live_scaling'):
        for env, expected in (('test', '0'), ('live', None)):
            text = (INFRA / 'app' / 'envs' / f'{env}.tfvars').read_text()
            body = next(blocks(text, key + r'\s*='))[1]
            minimum = re.search(r'min_instances\s*=\s*(\d+)', body).group(1)
            assert minimum == expected if expected else int(minimum) >= 1


def test_every_variable_set_value_is_declared():
    for root in ROOTS:
        declared = set(re.findall(r'variable\s+"([a-z_]+)"', code(INFRA / root / 'variables.tf')))
        for env in ENVS:
            assert set(tfvars(root, env)) <= declared, (root, env)


def test_roots_share_names_through_the_naming_module():
    for root in ROOTS:
        assert '../modules/naming' in code(INFRA / root / 'main.tf')


def test_check_script_never_plans_applies_or_destroys():
    script = (INFRA / 'scripts' / 'check.sh').read_text()
    assert '-backend=false' in script
    assert not re.search(r'\bterraform\b[^\n]*\b(plan|apply|destroy|import|state)\b', script)
    assert not re.search(r'\$TF\b[^\n]*\b(plan|apply|destroy|import|state)\b', script)
    assert not re.search(r'\bgcloud\b|\bfirebase\b', script)


def test_every_infra_file_is_under_the_line_limit():
    for path in files('.tf', '.tfvars', '.hcl', '.sh', '.md'):
        assert len(path.read_text().splitlines()) <= 1000, path


def test_every_root_has_a_mocked_test_suite():
    for root in ROOTS:
        suites = list((INFRA / root / 'tests').glob('*.tftest.hcl'))
        assert suites, root
        for suite in suites:
            text = suite.read_text()
            assert 'mock_provider "google"' in text
            assert 'command = apply' not in text


@pytest.mark.parametrize('root', ROOTS)
def test_runbook_describes_every_root(root):
    runbook = (ROOT / 'docs' / 'RUNBOOK.md').read_text()
    assert f'infra/dryscope/{root}' in runbook
