#!/usr/bin/env python3
"""Explicit, resumable HTTP rehearsal of the deployed 0.8 declared-email workflow.

Requires --allow-write and a private operator session file. Uses only shipped RPCs;
never calls Auth API, SQL administration, or the operator issuer. The synthetic
classroom and its first blind round remain open for browser verification.
"""
import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
TITLE = 'Техническая репетиция 0.8 — Мордовия'
FAMILY_TITLE = 'Техническое семейство 0.8 — компенсация платы за детский сад'
ROUND_TITLE = 'Технический закрытый раунд 0.8'
REGION = 'respublika-mordoviia'
PEOPLE = {
    'alice': {'email': 'dw08-cloud-alice@example.test', 'fullName': 'Технический участник А 0.8'},
    'bob': {'email': 'dw08-cloud-bob@example.test', 'fullName': 'Технический участник Б 0.8'},
}


class Failure(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Failure(code)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def atomic_json(path, value, private=False):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700 if private else 0o755)
    temporary = path.with_name(path.name + '.tmp-' + str(uuid.uuid4()))
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600 if private else 0o644)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise Failure('HTTP_REDIRECT_REFUSED')


class Api:
    def __init__(self, config, report):
        self.base = config['supabaseUrl'].rstrip('/')
        need(self.base == 'https://alyrowehwzypgtrqnvdi.supabase.co', 'UNEXPECTED_PROJECT')
        self.key = config['supabasePublishableKey']
        need(isinstance(self.key, str) and not self.key.startswith('sb_secret_'), 'PUBLIC_KEY_REQUIRED')
        self.opener = urllib.request.build_opener(NoRedirect())
        self.report = report
        self.secrets = set()

    def call(self, route, arguments, label, expected_error=None):
        need(route in {'dw_identify', 'dw_entry_session', 'dw_entry_logout', 'dw_entry_rpc'}, 'RPC_NOT_ALLOWED_BY_SMOKE')
        request = urllib.request.Request(self.base + '/rest/v1/rpc/' + route,
            data=json.dumps(arguments, ensure_ascii=False).encode('utf-8'),
            headers={'apikey': self.key, 'Content-Type': 'application/json'}, method='POST')
        start = time.monotonic()
        try:
            response = self.opener.open(request, timeout=40)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError):
            raise Failure('NETWORK_ERROR_' + route) from None
        with response:
            status = response.code
            raw = response.read(16 * 1024 * 1024 + 1)
        need(len(raw) <= 16 * 1024 * 1024, 'RESPONSE_TOO_LARGE')
        try:
            result = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise Failure('INVALID_HTTP_JSON_' + route) from None
        error_code = None
        if status >= 400:
            message = result.get('message', '') if isinstance(result, dict) else ''
            code = result.get('code', '') if isinstance(result, dict) else ''
            error_code = message if re.fullmatch(r'[A-Z0-9_]{1,80}', message) else code
            if not re.fullmatch(r'[A-Z0-9_]{1,80}', str(error_code)):
                error_code = 'HTTP_' + str(status)
        ok = (200 <= status < 300 and expected_error is None) or (status >= 400 and error_code == expected_error)
        item = {'label': label, 'route': route, 'httpStatus': status,
            'durationMs': round((time.monotonic() - start) * 1000, 2), 'passed': ok}
        if route == 'dw_entry_rpc':
            item['method'] = arguments['p_method']
        if error_code:
            item['errorCode'] = error_code
        self.report['requests'].append(item)
        need(ok, 'HTTP_CHECK_FAILED_' + label + '_' + str(error_code or status))
        if route == 'dw_identify' and isinstance(result, dict):
            self.secrets.add(result.get('session', {}).get('access_token', ''))
        return result

    def rpc(self, token, method, args=None, label=None, expected_error=None):
        return self.call('dw_entry_rpc', {'p_token': token, 'p_method': method, 'p_args': args or {}},
            label or method, expected_error)


def bundle():
    prepared = json.loads((ROOT / 'public/data/corpus/practices.json').read_text())
    variant = next(v for v in prepared['variants'] if v['id'] == 'mordovia-kindergarten-compensation')
    pick = lambda value, keys: {key: value[key] for key in keys if key in value}
    document = json.loads((ROOT / 'public/data/corpus/documents/regional-respublika-mordoviia.json').read_text())
    return {'schemaVersion': 1,
        'practice': pick(variant, ['id', 'familyId', 'regionId', 'title', 'mechanism', 'eligibility', 'amount',
            'conditions', 'occurrenceIds', 'evidence', 'reviewStatus']),
        'occurrences': [pick(item, ['id', 'documentId', 'versionId', 'anchor', 'reviewStatus', 'note'])
            for item in prepared['occurrences'] if item['id'] in variant['occurrenceIds']],
        'sources': [{'sourceId': document['meta']['id'], 'editionId': document['version']['id'],
            'title': document['meta']['title'], 'sha256': document['version']['sourceSha256'],
            'normalizationVersion': document['version']['normalizationVersion'],
            'sourceUrl': document['version']['sourceUrl'], 'regionId': REGION}],
        'note': 'Техническая репетиция нового входа 0.8; точная цитата исходной программы. Эффект меры не оценивается.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--operator-session-file', type=Path, required=True)
    parser.add_argument('--allow-write', action='store_true', required=True)
    parser.add_argument('--fixture-file', type=Path)
    parser.add_argument('--config', type=Path, default=ROOT / 'public/workshop-config.json')
    parser.add_argument('--report', type=Path, default=ROOT / 'scripts/deploy/stage8-http-validation.json')
    parser.add_argument('--close-fixture', action='store_true', help='Explicit cleanup after browser verification: close the round and classroom.')
    args = parser.parse_args()
    owner_file = args.operator_session_file.resolve()
    fixture_file = (args.fixture_file or owner_file.with_name('dw08-cloud-fixture.json')).resolve()
    need(not owner_file.is_relative_to(ROOT) and not fixture_file.is_relative_to(ROOT), 'PRIVATE_FILES_MUST_BE_OUTSIDE_REPOSITORY')
    owner = json.loads(owner_file.read_text())
    token = owner.get('access_token')
    need(isinstance(token, str) and re.fullmatch(r'[a-f0-9]{64}', token), 'OPERATOR_SESSION_FILE_INVALID')
    need(owner.get('expires_at', 0) > time.time(), 'OPERATOR_SESSION_EXPIRED')
    fixture = json.loads(fixture_file.read_text()) if fixture_file.exists() else {
        'schemaVersion': 1, 'title': TITLE, 'createdAt': now(), 'participants': PEOPLE, 'operationIds': {}}
    need(fixture.get('schemaVersion') == 1 and fixture.get('title') == TITLE, 'UNEXPECTED_FIXTURE')
    report = {'schemaVersion': 1, 'startedAt': now(), 'projectRef': 'alyrowehwzypgtrqnvdi',
        'transport': 'Real HTTPS PostgREST; Python urllib; public application key plus private opaque operator capability',
        'requests': [], 'assertions': [], 'status': 'running', 'scope': 'Synthetic application rehearsal; not physical device, Wi-Fi, SMTP or Realtime certification.'}
    if args.report.exists():
        previous = json.loads(args.report.read_text())
        if previous.get('schemaVersion') == 1 and previous.get('projectRef') == report['projectRef']:
            history = previous.pop('previousAttempts', [])
            report['previousAttempts'] = (history + [previous])[-10:]
    api = Api(json.loads(args.config.read_text()), report)
    api.secrets.add(token)
    lock = fixture_file.with_name(fixture_file.name + '.lock')
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)

    def save():
        fixture['updatedAt'] = now()
        atomic_json(fixture_file, fixture, private=True)

    def operation(key):
        if key not in fixture['operationIds']:
            fixture['operationIds'][key] = str(uuid.uuid4())
            save()
        return fixture['operationIds'][key]

    def check(label, condition):
        need(condition, 'ASSERTION_FAILED_' + label)
        report['assertions'].append(label)

    try:
        restored_owner = api.call('dw_entry_session', {'p_token': token}, 'operator_session')['session']
        check('existing_operator_identity', restored_owner['user']['id'] == owner['user']['id'])
        operator_boot = api.rpc(token, 'dw_bootstrap', label='operator_bootstrap')
        check('operator_can_create', operator_boot['canCreateSession'] is True)
        candidates = [s for s in operator_boot['sessions'] if s['title'] == TITLE and s['regionId'] == REGION]
        if fixture.get('sessionId'):
            candidates = [s for s in candidates if s['id'] == fixture['sessionId']]
            check('existing_fixture_membership', len(candidates) == 1)
        need(len(candidates) <= 1, 'DUPLICATE_TECHNICAL_CLASSROOMS_REQUIRE_REVIEW')
        if not candidates:
            need(not args.close_fixture, 'NO_FIXTURE_TO_CLOSE')
            state = api.rpc(token, 'dw_create_session', {'p_operation_id': operation('create'), 'p_title': TITLE,
                'p_scope': 'municipality', 'p_region_id': REGION}, 'create_technical_classroom')
            classroom = state['session']
            report['classroomCreatedThisRun'] = True
        else:
            classroom = candidates[0]
            report['classroomCreatedThisRun'] = False
        sid = classroom['id']
        fixture['sessionId'] = sid
        fixture['operatorId'] = owner['user']['id']
        save()

        if args.close_fixture:
            workshop = api.rpc(token, 'dw_workshop_snapshot', {'p_session_id': sid}, 'cleanup_snapshot')
            for item in workshop.get('rounds', []):
                if item['status'] == 'open':
                    api.rpc(token, 'dw_close_voting_round', {'p_operation_id': operation('close-round-' + item['id']),
                        'p_session_id': sid, 'p_round_id': item['id'], 'p_expected_revision': item['revision']}, 'close_technical_round')
            current = api.rpc(token, 'dw_session_snapshot', {'p_session_id': sid}, 'cleanup_classroom')['session']
            if current['status'] != 'closed' or current['joinOpen']:
                api.rpc(token, 'dw_update_session', {'p_operation_id': operation('close-classroom'), 'p_session_id': sid,
                    'p_expected_revision': current['revision'], 'p_patch': {'status': 'closed', 'joinOpen': False}}, 'close_technical_classroom')
            fixture['status'] = 'closed'
            report['status'] = 'closed'
            report['effects'] = 'Closed only the previously identified technical round and classroom; retained authored test material and audit history.'
            save()
            return

        check('technical_classroom_open', classroom['status'] == 'open' and classroom['joinOpen'])
        sessions = {}
        for key, person in PEOPLE.items():
            session = api.call('dw_identify', {'p_email': person['email'], 'p_full_name': person['fullName']}, 'identify_' + key)['session']
            sessions[key] = session
            check('email_unverified_' + key, session['user']['email_confirmed_at'] is None and
                session['user']['app_metadata']['email_verified'] is False)
            previous = fixture['participants'].get(key, {}).get('actorId')
            check('identity_stable_' + key, previous is None or previous == session['user']['id'])
            fixture['participants'][key] = {**person, 'actorId': session['user']['id']}
            save()
        check('independent_participants', sessions['alice']['user']['id'] != sessions['bob']['user']['id'])
        a, b = sessions['alice']['access_token'], sessions['bob']['access_token']
        api.rpc(a, 'dw_create_session', {'p_operation_id': operation('denied-create'), 'p_title': 'Недопустимое действие — техническая проверка',
            'p_scope': 'federal', 'p_region_id': None}, 'participant_host_action_denied', expected_error='FORBIDDEN')
        for key, session in sessions.items():
            available = api.rpc(session['access_token'], 'dw_available_sessions', label='open_list_' + key)
            check('classroom_listed_' + key, any(s['id'] == sid for s in available))
            joined = api.rpc(session['access_token'], 'dw_join_open_session', {'p_session_id': sid,
                'p_operation_id': operation('join-' + key)}, 'join_' + key)
            check('joined_' + key, joined['session']['id'] == sid and any(m['userId'] == session['user']['id'] for m in joined['members']))

        material = bundle()
        state = api.rpc(a, 'dw_session_snapshot', {'p_session_id': sid}, 'source_snapshot')
        submissions = [s for s in state['submissions'] if s['authorId'] == sessions['alice']['user']['id'] and s['localKey'] == 'stage8-cloud-http-mordovia']
        if not submissions:
            state = api.rpc(a, 'dw_publish_submission', {'p_operation_id': operation('publish'), 'p_session_id': sid,
                'p_local_key': 'stage8-cloud-http-mordovia', 'p_expected_revision': None, 'p_bundle': material}, 'publish_canonical_quote')
            submissions = [s for s in state['submissions'] if s['authorId'] == sessions['alice']['user']['id'] and s['localKey'] == 'stage8-cloud-http-mordovia']
        check('canonical_bundle_preserved', len(submissions) == 1 and submissions[0]['status'] == 'shared' and submissions[0]['bundle'] == material)
        submission = submissions[0]
        fixture['submissionId'] = submission['id']
        save()
        workshop = api.rpc(token, 'dw_workshop_snapshot', {'p_session_id': sid}, 'family_snapshot')
        families = [f for f in workshop['families'] if f['title'] == FAMILY_TITLE and f['submissionIds'] == [submission['id']]]
        if not families:
            workshop = api.rpc(token, 'dw_save_family', {'p_operation_id': operation('family'), 'p_session_id': sid,
                'p_family_id': None, 'p_expected_board_revision': workshop['boardRevision'], 'p_title': FAMILY_TITLE,
                'p_mechanism': 'Возмещение части родительской платы; региональные условия сохранены в исходной цитате.',
                'p_rationale': 'Техническая проверка связи документа, практики и фиксированного голосования. Эффект меры не оценивается.',
                'p_submission_ids': [submission['id']]}, 'create_source_family')
            families = [f for f in workshop['families'] if f['title'] == FAMILY_TITLE and f['submissionIds'] == [submission['id']]]
        check('one_fixture_family', len(families) == 1)
        fid = families[0]['id']
        fixture['familyId'] = fid
        save()
        current = api.rpc(token, 'dw_session_snapshot', {'p_session_id': sid}, 'before_round')['session']
        if current['phase'] != 'discussion':
            api.rpc(token, 'dw_update_session', {'p_operation_id': operation('discussion'), 'p_session_id': sid,
                'p_expected_revision': current['revision'], 'p_patch': {'phase': 'discussion'}}, 'discussion_phase')
        rounds = [r for r in workshop['rounds'] if r['title'] == ROUND_TITLE]
        if not rounds:
            opened = api.rpc(token, 'dw_open_voting_round', {'p_operation_id': operation('round'), 'p_session_id': sid,
                'p_title': ROUND_TITLE, 'p_results_visibility': 'after_close', 'p_expected_board_revision': workshop['boardRevision'],
                'p_settings': {'minCoverage': 0.5, 'minSubstantiveVotes': 2}}, 'open_frozen_round')
            active = opened['round']
        else:
            check('one_fixture_round', len(rounds) == 1)
            active = api.rpc(token, 'dw_workshop_round_snapshot', {'p_session_id': sid, 'p_round_id': rounds[0]['id']}, 'existing_frozen_round')
        fixture['roundId'] = active['id']
        save()
        frozen = next(f for f in active['families'] if f['id'] == fid)
        check('frozen_source_exact', frozen['variants'][0]['bundle'] == material and frozen['variants'][0]['submissionRevision'] == submission['revision'])
        check('blind_open_round', active['status'] == 'open' and not active['totalsVisible'] and frozen['totals'] is None)
        check('captured_roster', active['eligibleCount'] >= 3)
        for key, desired in [('alice', 1), ('bob', -1)]:
            own = api.rpc(sessions[key]['access_token'], 'dw_workshop_round_snapshot', {'p_session_id': sid,
                'p_round_id': active['id']}, 'own_round_' + key)
            family = next(f for f in own['families'] if f['id'] == fid)
            if family['myVote'] != desired:
                need(not fixture.get('votesVerified'), 'FIXTURE_BALLOT_CHANGED')
                own = api.rpc(sessions[key]['access_token'], 'dw_cast_vote', {'p_operation_id': operation('vote-' + key),
                    'p_session_id': sid, 'p_round_id': active['id'], 'p_family_id': fid, 'p_value': desired,
                    'p_expected_revision': family['myVoteRevision']}, 'cast_vote_' + key)['round']
                family = next(f for f in own['families'] if f['id'] == fid)
            check('own_vote_private_' + key, family['myVote'] == desired and family['totals'] is None)
        api.call('dw_entry_logout', {'p_token': a}, 'participant_logout')
        api.call('dw_entry_session', {'p_token': a}, 'old_session_revoked', expected_error='AUTH_REQUIRED')
        again = api.call('dw_identify', {'p_email': '  ' + PEOPLE['alice']['email'].upper() + '  ',
            'p_full_name': PEOPLE['alice']['fullName']}, 'participant_reentry')['session']
        check('same_uuid_after_logout', again['user']['id'] == sessions['alice']['user']['id'])
        resumed = api.rpc(again['access_token'], 'dw_workshop_round_snapshot', {'p_session_id': sid,
            'p_round_id': active['id']}, 'vote_after_reentry')
        check('vote_restored_after_reentry', next(f for f in resumed['families'] if f['id'] == fid)['myVote'] == 1)
        peer = api.rpc(b, 'dw_workshop_round_snapshot', {'p_session_id': sid, 'p_round_id': active['id']}, 'peer_unaffected')
        check('second_participant_unchanged', next(f for f in peer['families'] if f['id'] == fid)['myVote'] == -1)
        projection = api.rpc(token, 'dw_workshop_projector_snapshot', {'p_session_id': sid}, 'projector_blind_results')
        check('projector_no_intermediate_totals', not projection['round']['totalsVisible'] and all(f['totals'] is None and 'myVote' not in f for f in projection['round']['families']))
        fixture.update({'status': 'ready-open', 'votesVerified': True, 'lastVerifiedAt': now()})
        save()
        report.update({'status': 'passed', 'classroomLeftOpen': True, 'roundLeftOpen': True,
            'effects': {'syntheticLearnersUsed': 2, 'technicalClassroomsUsed': 1, 'sourceBundlesUsed': 1,
                'practiceFamiliesUsed': 1, 'frozenRoundsUsed': 1, 'ballotsVerified': 2,
                'operatorCreated': False, 'emailsSent': False, 'ddlExecuted': False}})
    except Failure as error:
        report['status'] = 'failed'
        report['failureCode'] = str(error)
        raise
    except Exception as error:
        report['status'] = 'failed'
        report['failureCode'] = 'CLIENT_CONTRACT_ERROR_' + type(error).__name__
        raise Failure(report['failureCode']) from None
    finally:
        report['finishedAt'] = now()
        report['requestCounts'] = dict(collections.Counter(item['route'] for item in report['requests']))
        report['authApiRequests'] = sum(1 for item in report['requests'] if item['route'].startswith('/auth/'))
        encoded = json.dumps(report, ensure_ascii=False)
        need(not any(secret and secret in encoded for secret in api.secrets), 'SECRET_IN_REPORT_REFUSED')
        atomic_json(args.report.resolve(), report)
        lock.unlink(missing_ok=True)
        print(json.dumps({'status': report['status'], 'assertionsPassed': len(report['assertions']),
            'httpRequests': len(report['requests']), 'authApiRequests': report['authApiRequests']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Failure as error:
        print(json.dumps({'status': 'failed', 'code': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
