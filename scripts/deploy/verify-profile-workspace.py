#!/usr/bin/env python3
"""Live 0.8.2 email-first/profile/notebook checks against existing synthetic actors.

Requires explicit --allow-write. Teacher is read-only; only the two existing
technical participants are used. The first participant's profile and notebook
contents are restored in finally. A previously absent notebook is left empty.
Private tokens are kept in memory, never in output or the recovery checkpoint.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('dw_entry_http', Path(__file__).with_name('verify-simple-entry.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
Api, Failure, need, atomic_json, now = helpers.Api, helpers.Failure, helpers.need, helpers.atomic_json, helpers.now


def empty_workspace():
    return {'schemaVersion': 1, 'id': 'personal-workspace', 'title': 'Моя рабочая тетрадь', 'profile': None,
        'sourceReferences': [], 'annotations': [], 'practiceProposals': [], 'linkDecisions': [],
        'customCards': [], 'readingTasks': [], 'preferences': {'selectedRegionId': None,
        'selectedSourceEditionId': None, 'selectedPracticeId': None, 'activePanel': 'documents', 'readerFontScale': 1}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-write', action='store_true', required=True)
    parser.add_argument('--config', type=Path, default=ROOT / 'public/workshop-config.json')
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--recovery-file', type=Path, required=True)
    args = parser.parse_args()
    need(not args.report.resolve().is_relative_to(ROOT), 'REPORT_MUST_BE_OUTSIDE_REPOSITORY')
    need(not args.recovery_file.resolve().is_relative_to(ROOT), 'RECOVERY_MUST_BE_OUTSIDE_REPOSITORY')
    need(not args.recovery_file.exists(), 'RECOVERY_ALREADY_EXISTS_REVIEW_BEFORE_REPEAT')
    run = str(uuid.uuid4())
    report = {'schemaVersion': 1, 'release': '0.8.2', 'startedAtUtc': now(), 'projectRef': 'alyrowehwzypgtrqnvdi',
        'probeReference': run, 'transport': 'Live HTTPS PostgREST with public application key and declared entry sessions',
        'scope': 'Existing synthetic participants; teacher profile read only; no DDL, Auth API, shared-classroom or survey changes',
        'requests': [], 'assertions': [], 'cleanup': {}, 'status': 'running'}
    api = Api(json.loads(args.config.read_text()), report)
    tokens = set()
    private_values = set()
    original_name = None
    original_workspace = None
    baseline_read = False
    alice = None
    edited_name = 'Техническая проверка профиля 0.8.2 — ' + run[:8]
    titles = ['Техническая тетрадь 0.8.2 — ' + run[:8] + ' — ' + str(i) for i in (1, 2)]
    touched_profile = False
    touched_workspace = False

    def check(label, condition):
        need(condition, 'ASSERTION_FAILED_' + label)
        report['assertions'].append(label)

    def identify(email, label, supplied_name=None):
        arguments = {'p_email': email}
        if supplied_name is not None:
            arguments['p_full_name'] = supplied_name
        result = api.call('dw_identify', arguments, label)
        need(isinstance(result.get('session'), dict), 'EXISTING_FIXTURE_PROFILE_REQUIRED_' + label)
        session = result['session']
        tokens.add(session['access_token'])
        for value in (email, session['user']['id'], session['user'].get('email'),
            session['user'].get('user_metadata', {}).get('full_name')):
            if isinstance(value, str) and value:
                private_values.add(value)
        return session

    def read_workspace(session, label, known=-1):
        return api.rpc(session['access_token'], 'dw_workspace_read', {'p_known_revision': known}, label)

    def commit(session, state, revision, operation, label, expected_error=None):
        return api.rpc(session['access_token'], 'dw_workspace_commit', {'p_operation_id': operation,
            'p_expected_revision': revision, 'p_state': state}, label, expected_error)

    def logout(session, label):
        api.call('dw_entry_logout', {'p_token': session['access_token']}, label)
        tokens.discard(session['access_token'])

    try:
        probe = 'dw082-probe-' + run + '@example.test'
        private_values.add(probe)
        unknown = api.call('dw_identify', {'p_email': '  ' + probe.upper() + '  '}, 'unknown_email_only')
        check('unknown_email_requests_profile_without_session', unknown == {'profileRequired': True, 'email': probe})

        teacher = identify('  OMNISTAT@YANDEX.RU  ', 'teacher_email_only')
        teacher_profile = api.rpc(teacher['access_token'], 'dw_bootstrap', label='teacher_saved_profile')
        check('teacher_saved_name_present', bool(teacher_profile['profile']['fullName']))
        check('teacher_saved_name_used_for_entry', teacher['user']['user_metadata']['full_name'] == teacher_profile['profile']['fullName'])
        check('teacher_role_available', teacher_profile['canCreateSession'] is True)
        same_teacher = identify('omnistat@yandex.ru', 'teacher_return_by_email')
        check('teacher_uuid_and_name_stable', same_teacher['user']['id'] == teacher['user']['id'] and
            same_teacher['user']['user_metadata']['full_name'] == teacher_profile['profile']['fullName'])
        logout(teacher, 'teacher_first_transport_logout')
        logout(same_teacher, 'teacher_second_transport_logout')

        alice = identify('dw08-cloud-alice@example.test', 'existing_alice_email_only')
        bob = identify('dw08-cloud-bob@example.test', 'existing_bob_email_only')
        boot = api.rpc(alice['access_token'], 'dw_bootstrap', label='alice_profile_before')
        original_name = boot['profile']['fullName']
        private_values.add(original_name)
        check('ordinary_actor_has_no_teacher_role', boot['canCreateSession'] is False)
        original_workspace = read_workspace(alice, 'alice_workspace_before')['snapshot']
        bob_workspace = read_workspace(bob, 'bob_workspace_before')
        baseline_read = True
        atomic_json(args.recovery_file, {'schemaVersion': 1, 'createdAtUtc': now(), 'runReference': run,
            'technicalEmail': 'dw08-cloud-alice@example.test', 'originalFullName': original_name,
            'originalWorkspace': original_workspace, 'temporaryFullName': edited_name, 'temporaryTitles': titles}, private=True)

        touched_profile = True
        updated_profile = api.rpc(alice['access_token'], 'dw_save_profile', {'p_operation_id': str(uuid.uuid4()),
            'p_expected_revision': boot['profile']['revision'], 'p_full_name': edited_name}, 'explicit_profile_edit')
        check('explicit_profile_edit_saved', updated_profile['fullName'] == edited_name)
        next_alice = identify('DW08-CLOUD-ALICE@EXAMPLE.TEST', 'alice_return_after_name_edit')
        check('email_only_return_uses_edited_name', next_alice['user']['id'] == alice['user']['id'] and
            next_alice['user']['user_metadata']['full_name'] == edited_name)
        legacy_alice = identify('dw08-cloud-alice@example.test', 'legacy_login_name_ignored', 'Имя из устаревшей формы')
        after_legacy = api.rpc(legacy_alice['access_token'], 'dw_bootstrap', label='profile_after_legacy_login')
        check('login_never_rewrites_saved_name_or_revision', after_legacy['profile']['fullName'] == edited_name and
            after_legacy['profile']['revision'] == updated_profile['revision'])

        state = copy.deepcopy(original_workspace['state'] if original_workspace else empty_workspace())
        state['title'] = titles[0]
        first_revision = original_workspace['revision'] if original_workspace else 0
        first_operation = str(uuid.uuid4())
        touched_workspace = True
        first = commit(alice, state, first_revision, first_operation, 'workspace_first_commit')
        check('first_workspace_commit_acknowledged', first['kind'] == 'committed' and not first['replayed'] and
            first['snapshot']['state'] == state and first['revision'] == first_revision + 1)
        new_device = identify('dw08-cloud-alice@example.test', 'alice_new_device_email_only')
        reopened = read_workspace(new_device, 'workspace_from_new_device')
        check('workspace_restored_after_new_entry', reopened == {'snapshot': first['snapshot']})
        scalar = read_workspace(new_device, 'workspace_unchanged_scalar', first['snapshot']['revision'])
        check('unchanged_poll_omits_notebook_payload', scalar == {'unchanged': True, 'revision': first['snapshot']['revision']})
        second_state = copy.deepcopy(state)
        second_state['title'] = titles[1]
        second = commit(new_device, second_state, first['revision'], str(uuid.uuid4()), 'workspace_second_commit')
        check('next_workspace_revision_saved', second['revision'] == first['revision'] + 1 and second['snapshot']['state'] == second_state)
        stale = commit(alice, state, first_revision, str(uuid.uuid4()), 'workspace_stale_write_conflict')
        check('stale_write_keeps_current_snapshot', stale == {'kind': 'conflict', 'expectedRevision': first_revision,
            'actualRevision': second['revision'], 'snapshot': second['snapshot']})
        replay = commit(alice, state, first_revision, first_operation, 'workspace_idempotent_replay')
        check('replay_preserves_applied_revision_and_latest_snapshot', replay == {'kind': 'committed',
            'revision': first['revision'], 'replayed': True, 'snapshot': second['snapshot']})
        commit(alice, second_state, first_revision, first_operation, 'workspace_reused_operation_rejected', 'IDEMPOTENCY_CONFLICT')
        malformed = copy.deepcopy(second_state)
        malformed['profile'] = {'displayName': 'Не сохранять профиль в тетради'}
        commit(alice, malformed, second['revision'], str(uuid.uuid4()), 'workspace_profile_copy_rejected', 'INVALID_INPUT')
        check('invalid_commit_does_not_change_saved_work', read_workspace(new_device, 'workspace_after_rejections') == {'snapshot': second['snapshot']})
        check('other_actor_notebook_unchanged', read_workspace(bob, 'bob_workspace_after') == bob_workspace)
        api.rpc(bob['access_token'], 'dw_workspace_read', {'p_known_revision': -1, 'p_user_id': alice['user']['id']},
            'workspace_owner_argument_rejected', 'INVALID_INPUT')
        logout(alice, 'alice_first_transport_logout')
        api.rpc(alice['access_token'], 'dw_workspace_read', {}, 'revoked_transport_read_rejected', 'AUTH_REQUIRED')
        check('second_device_survives_first_device_logout', read_workspace(new_device, 'workspace_after_other_device_logout') == {'snapshot': second['snapshot']})
        alice = new_device
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['errorCode'] = str(error) if isinstance(error, Failure) else type(error).__name__
    finally:
        # All compensation uses the ordinary application API and compares current
        # content first, so a concurrent unrelated edit is not silently discarded.
        compensation_errors = []
        recovery = None
        if baseline_read and (touched_profile or touched_workspace):
            try:
                recovery = identify('dw08-cloud-alice@example.test', 'cleanup_email_entry')
            except Exception as error:
                compensation_errors.append(str(error) if isinstance(error, Failure) else type(error).__name__)
        if recovery and touched_profile:
            try:
                current_profile = api.rpc(recovery['access_token'], 'dw_bootstrap', label='cleanup_profile_read')['profile']
                need(current_profile['fullName'] in {original_name, edited_name}, 'CLEANUP_CONCURRENT_PROFILE_EDIT_REQUIRES_REVIEW')
                if current_profile['fullName'] != original_name:
                    restored = api.rpc(recovery['access_token'], 'dw_save_profile', {'p_operation_id': str(uuid.uuid4()),
                        'p_expected_revision': current_profile['revision'], 'p_full_name': original_name}, 'restore_original_profile')
                    need(restored['fullName'] == original_name, 'CLEANUP_PROFILE_RESTORE_FAILED')
                final_entry = identify('dw08-cloud-alice@example.test', 'verify_original_name_on_email_entry')
                need(final_entry['user']['user_metadata']['full_name'] == original_name, 'CLEANUP_PROFILE_MISMATCH')
                report['cleanup']['profileNameRestored'] = True
            except Exception as error:
                compensation_errors.append(str(error) if isinstance(error, Failure) else type(error).__name__)
        if recovery and touched_workspace:
            try:
                current = read_workspace(recovery, 'cleanup_workspace_read')['snapshot']
                original_state = original_workspace['state'] if original_workspace else empty_workspace()
                if current is None:
                    need(original_workspace is None, 'CLEANUP_CURRENT_WORKSPACE_MISSING')
                else:
                    need(current['state']['title'] in titles or current['state'] == original_state,
                        'CLEANUP_CONCURRENT_WORKSPACE_EDIT_REQUIRES_REVIEW')
                    if current['state'] != original_state:
                        restored = commit(recovery, original_state, current['revision'], str(uuid.uuid4()), 'restore_original_workspace')
                        need(restored['kind'] == 'committed' and restored['snapshot']['state'] == original_state,
                            'CLEANUP_WORKSPACE_RESTORE_FAILED')
                final_workspace = read_workspace(recovery, 'verify_restored_workspace')['snapshot']
                need((final_workspace is None and original_workspace is None) or
                    (final_workspace is not None and final_workspace['state'] == original_state), 'CLEANUP_WORKSPACE_MISMATCH')
                report['cleanup']['workspaceContentRestored'] = True
                report['cleanup']['previouslyAbsentNotebookLeftEmpty'] = original_workspace is None and final_workspace is not None
            except Exception as error:
                compensation_errors.append(str(error) if isinstance(error, Failure) else type(error).__name__)
        report['cleanup']['compensationPassed'] = not compensation_errors
        if compensation_errors:
            report['status'] = 'failed'
            report['cleanup']['errorCodes'] = compensation_errors
        elif args.recovery_file.exists():
            args.recovery_file.unlink()
        failed_logouts = 0
        for index, token in enumerate(sorted(tokens)):
            try:
                api.call('dw_entry_logout', {'p_token': token}, 'cleanup_transport_' + str(index))
            except Exception:
                failed_logouts += 1
        report['cleanup']['remainingTransportLogoutFailures'] = failed_logouts
        if failed_logouts:
            report['status'] = 'failed'
        report['finishedAtUtc'] = now()
        report['requestCount'] = len(report['requests'])
        report['assertionCount'] = len(report['assertions'])
        report['authApiRequests'] = 0
        encoded = json.dumps(report, ensure_ascii=False)
        for secret in api.secrets | private_values | {edited_name}:
            if secret and secret in encoded:
                raise Failure('PRIVATE_VALUE_FOUND_IN_REPORT')
        atomic_json(args.report, report)
        print(json.dumps({'status': report['status'], 'assertions': report['assertionCount'],
            'requests': report['requestCount'], 'cleanup': report['cleanup'], 'report': str(args.report)}, ensure_ascii=False))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Failure as error:
        print(json.dumps({'status': 'failed', 'errorCode': str(error)}, ensure_ascii=False))
        sys.exit(1)
