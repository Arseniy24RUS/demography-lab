#!/usr/bin/env python3
"""Generate reviewable same-measure suggestions for the pinned family-support catalogue."""

import argparse
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path
import re
import unicodedata


CORPUS = Path(__file__).resolve().parents[2] / 'public/data/corpus'
CATALOG = CORPUS / 'family-catalog.json'
OUTPUT = CORPUS / 'family-catalog-groups.json'

# Aliases are used only to strip a matching parenthesized region from the title.
TITLE_REGION_ALIASES = {
    'Республика Татарстан (Татарстан)': ('Республика Татарстан',),
    'Чувашская Республика — Чувашия': ('Чувашская Республика',),
    'Ханты-Мансийский автономный округ — Югра': ('ХМАО — Югра',),
    'Ямало-Ненецкий автономный округ': ('ЯНАО',),
}
PARTS = re.compile(r'[«»„“”"]')
DASHES = str.maketrans('‐‑‒–—−', '------')


def normalized(text):
    clean = unicodedata.normalize('NFC', text).translate(DASHES).casefold().replace('ё', 'е')
    return ' '.join(PARTS.sub('', clean).split())


def without_region(measure):
    title = measure['title'].strip()
    region = measure['region']
    if not region:
        return title
    aliases = {normalized(name) for name in (region, *TITLE_REGION_ALIASES.get(region, ()))}
    # A statutory or eligibility qualifier in parentheses is part of the measure.
    for index, char in enumerate(title):
        if char == '(' and title.endswith(')') and normalized(title[index + 1:-1]) in aliases:
            return title[:index].rstrip()
    return title


MONEY = 'Выплаты и пособия'
HOUSING = 'Жильё и ипотека'
SCHOOL = 'Образование'
CARE = 'Помощь и сопровождение'
WORK = 'Работа и занятость'
TRAVEL = 'Транспорт'

# Each rule describes one recognizable mechanism and uses full title matches.
# Shared labels do not import conditions, amounts, reviews or citations into other variants.
MECHANISMS = (
    ('regional-maternal-capital', 'Региональный материнский (семейный) капитал', (MONEY,),
     r'(?:(?:региональный(?: и краевой)?|областной|краевой|республиканский|окружной) )?'
     r'(?:материнский(?: \(семейный\))?|семейный|родительский \(материнский\)) капитал'
     r'(?: (?:семья|(?:на|за|при рождении|для) .+|в алтайском крае))?'
     r'|именной капитал семья|югорский семейный капитал', None),
    ('regional-social-contract', 'Социальный контракт', (WORK, MONEY),
     r'социальный контракт|государственная социальная помощь '
     r'(?:на основании социального контракта|по социальному контракту)', None),
    ('regional-kindergarten-fee-compensation', 'Компенсация родительской платы за детский сад', (SCHOOL,),
     r'компенсация (?:части )?(?:родительской )?платы за (?:детский сад|детсад)',
     r'\b(?:плата за частный|частн\w+ (?:сад|детсад)|отсутств\w+ мест)\b'),
    ('regional-social-nanny', 'Социальная няня', (CARE,),
     r'(?:бесплатная услуга |услуга )?социальная няня(?: - присмотр за детьми до 3 лет)?', None),
    ('regional-student-pregnancy-payment', 'Выплата беременным студенткам', (MONEY,),
     r'(?:единовременная )?выплата(?: [\d ]+ ₽)? беременн(?:ой|ым) студентк(?:е|ам)'
     r'(?: очной формы(?: обучения)?)?', None),
    ('regional-student-birth-payment', 'Выплата при рождении ребёнка в студенческой семье', (MONEY,),
     r'(?:единовременная )?выплата (?:при рождении ребенка в студенческой семье'
     r'|студенческим семьям при рождении ребенка)', None),
    ('regional-young-family-third-birth-payment', 'Выплата при рождении третьего ребёнка в молодой семье', (MONEY,),
     r'(?:единовременная )?выплата (?:при рождении третьего (?:ребенка|и последующих детей) в молодой семье'
     r'|молодым семьям при рождении третьего ребенка)', None),
    ('regional-first-birth-payment', 'Единовременная выплата при рождении первого ребёнка', (MONEY,),
     r'(?:единовременная )?выплата при рождении первого ребенка',
     r'\b(?:ежемесячн\w+ выплат\w+|выплачива\w+ ежемесячно|материнск\w+ капитал)\b'),
    ('regional-large-family-id', 'Удостоверение многодетной семьи', (CARE,),
     r'(?:выдача )?удостоверение многодетной семьи|выдача удостоверения многодетной семьи', None),
    ('regional-in-kind-newborn-kit', 'Подарочный набор для новорождённого', (CARE,),
     r'подарок новорожденному|подарочн(?:ый|ые) (?:набор|комплект|комплекты) '
     r'(?:для )?новорожденн(?:ому|ого|ым)(?: (?:малышу тывы|новому жителю кировской области))?',
     r'\b(?:сертификат|взамен|на выбор|либо|выплат\w+)\b'),
    ('regional-large-family-utility-compensation', 'Компенсация расходов на ЖКУ многодетным семьям',
     (HOUSING, 'Налоги и льготы'),
     r'компенсация (?:\d+\s*%\s*)?(?:расходов на (?:оплату )?)?жку (?:многодетным|многодетным семьям)', None),
    ('regional-disabled-child-utility-compensation', 'Компенсация расходов на ЖКУ семьям с детьми-инвалидами',
     (HOUSING, 'Налоги и льготы'),
     r'компенсация (?:\d+\s*%\s*)?(?:расходов на (?:оплату )?)?жку семьям с детьми-инвалидами', None),
    ('regional-large-family-land', 'Бесплатный земельный участок многодетным семьям', (HOUSING,),
     r'(?:бесплатн(?:ый|ое предоставление) )?земельн(?:ый|ого) участ(?:ок|ка) многодетным семьям',
     r'\b(?:взамен|вместо участка|или (?:денежн\w+ )?выплат\w+|на выбор|сертификат)\b'),
    ('regional-large-family-land-payment', 'Денежная выплата вместо земельного участка многодетным семьям',
     (HOUSING,),
     r'(?:единовременная )?выплата (?:многодетным(?: семьям)? )?(?:взамен|вместо) земельного участка'
     r'(?: многодетным(?: семьям)?)?', None),
    ('regional-large-family-land-or-payment', 'Земельный участок или выплата по выбору многодетной семьи',
     (HOUSING,), r'земельный участок или выплата многодетным(?: семьям)?', None),
    ('regional-gas-equipment-subsidy', 'Субсидия на газовое оборудование при догазификации', (HOUSING,),
     r'субсидия на (?:газовое оборудование при догазификации|покупку и установку газового оборудования)', None),
    ('regional-young-family-rent-compensation', 'Компенсация найма жилья молодым семьям', (HOUSING,),
     r'компенсация найма жилья молод(?:ой семье|ым семьям)(?: при рождении ребенка| с детьми)?', None),
    ('regional-large-family-child-free-medicine', 'Бесплатные лекарства детям до 6 лет из многодетных семей',
     ('Здоровье',),
     r'бесплатные лекарства детям (?:до 6 лет из многодетных семей|из многодетных семей до 6 лет)', None),
    ('regional-large-family-child-free-transport', 'Бесплатный проезд детям из многодетных семей', (TRAVEL,),
     r'бесплатный проезд (?:детям|школьникам|школьников) из многодетных семей', None),
    ('regional-kindergarten-priority-large-family', 'Первоочередной приём в детский сад для многодетных семей',
     (SCHOOL,),
     r'первоочередной прием (?:в детский сад (?:многодетным|детям из многодетных семей)'
     r'|детей из многодетных семей в детский сад)', None),
    ('regional-kindergarten-fee-waiver-svo', 'Освобождение от платы за детский сад детям участников СВО',
     (SCHOOL,),
     r'(?:освобождение от платы за детский сад (?:для детей|детям)|бесплатный (?:детский сад|детсад) детям) '
     r'участников сво', None),
    ('regional-equipment-lending-infant', 'Прокат детских вещей для детей до двух лет', (CARE,),
     r'(?:пункты )?прокат (?:детских )?(?:вещей|предметов первой необходимости) для детей до 2 лет', None),
    ('regional-equipment-lending-newborn', 'Прокат вещей для новорождённых', (CARE,),
     r'(?:пункты )?прокат (?:детских )?(?:вещей|предметов первой необходимости) для новорожденных', None),
)

# Families with this wording name a distinct object and form of support. Generic titles
# such as «Пособие на ребёнка», «Льготы» and «Государственная социальная помощь» are absent.
SPECIFIC_TITLES = frozenset('''
автомобиль семьям с 7 и более детьми
бесплатная психологическая помощь семьям сво
бесплатное горячее питание в школе для детей участников сво
бесплатное питание школьников из многодетных семей
бесплатное питание школьников и студентов из многодетных семей
бесплатное питание студентов колледжей
бесплатное питание студентов спо из многодетных семей
бесплатное посещение музеев многодетным
бесплатные кружки и секции детям участников сво
бесплатные лекарства детям до 3 лет и многодетным до 6
бесплатные музеи и парки многодетным
возмещение проезда к санаторному лечению
временное трудоустройство подростков 14-18 лет
выплата детям с фенилкетонурией
выплата за звание мать-героиня
выплата за знак материнская слава
выплата за орден родительская слава
выплата на жилье при рождении тройни и более
выплата на жилье семьям с 10+ детьми
выплата на лекарства детям до 6 лет в многодетных семьях
выплата на питание беременным
выплата на питание беременным и детям до 3 лет
выплата на питание беременным женщинам
выплата на питание детей до 3 лет
выплата на питание детям до 3 лет
выплата на питание кормящим матерям
выплата на школьную одежду многодетным
выплата на школьную форму многодетным
выплата при рождении двойни и более
выплата при рождении двойни или тройни
выплата при рождении первого ребенка маме до 25 лет
выплата при рождении тройни и более
детский сад бесплатно для многодетных
дополнительная выплата на погашение ипотеки многодетным
единовременная выплата при одновременном рождении трех и более детей
единовременная выплата при рождении ребенка в семье участника сво
единовременная материальная помощь детям участников сво
единовременное пособие при рождении ребенка
ежемесячная выплата на ребенка-инвалида
ежемесячная выплата на третьего ребенка до 3 лет
ежемесячная выплата по уходу за ребенком-инвалидом
ежемесячное пособие по уходу за ребенком-инвалидом
ежемесячное пособие студенческим семьям с детьми
компенсация 50% стоимости обучения ребенка из многодетной семьи
компенсация жку и капремонта семьям с ребенком-инвалидом
компенсация затрат на обучение ребенка-инвалида на дому
компенсация найма жилья студенческим семьям
компенсация на питание беременным, кормящим и детям до 3 лет
компенсация обучения детей из многодетных семей по спо
компенсация проезда детям участников сво
компенсация проезда школьникам из многодетных семей
компенсация расходов на газификацию домовладения
льготный проезд детям-инвалидам
обеспечение школьной формой многодетным
освобождение от транспортного налога многодетным
пособие на школьную одежду многодетным
профобучение многодетных родителей
профобучение родителей в декрете и ищущих работу
субсидия на догазификацию жилого дома
субсидия на жилье при рождении тройни и более
'''.strip().splitlines())


def propose_groups(payload):
    records = payload['measures']
    by_id = {card['id']: card for card in records}
    if len(by_id) != len(records):
        raise ValueError('Duplicate catalogue measure ID')

    rules = [(key, title, categories, re.compile(pattern), re.compile(exclude) if exclude else None)
             for key, title, categories, pattern, exclude in MECHANISMS]
    memberships = defaultdict(list)
    same_title = defaultdict(list)
    for card in records:
        if card['level'] != 'regional' or not card['region']:
            continue
        title = without_region(card)
        key = normalized(title)
        description = normalized(' '.join((card['summary'] or '', card['benefit'] or '')))
        for group_id, label, categories, pattern, exclude in rules:
            if card['category'] in categories and pattern.fullmatch(key):
                if not exclude or not exclude.search(description):
                    memberships[group_id].append(card['id'])
                # An exclusion carries substantive information. Do not recover the same card by title.
                break
        else:
            if key in SPECIFIC_TITLES:
                same_title[(card['category'], key)].append((title, card['id']))

    def has_distinct_regions(ids):
        return len({normalized(by_id[id]['region']) for id in ids}) > 1

    groups = [
        {'id': key, 'title': label, 'kind': 'mechanism', 'catalogIds': sorted(memberships[key])}
        for key, label, *_ in rules if has_distinct_regions(memberships[key])
    ]
    for (category, key), candidates in same_title.items():
        ids = sorted(id for _, id in candidates)
        if has_distinct_regions(ids):
            digest = sha256(f'{category}\n{key}'.encode('utf-8')).hexdigest()[:16]
            groups.append({'id': f'regional-title-{digest}', 'title': min(title for title, _ in candidates),
                           'kind': 'same-title', 'catalogIds': ids})

    return {
        'schemaVersion': 1,
        'catalogCommit': payload['source']['commit'],
        'cardCount': len(records),
        'groups': sorted(groups, key=lambda group: group['id']),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='compare generated bytes with the tracked sidecar')
    options = parser.parse_args()
    result = propose_groups(json.loads(CATALOG.read_text(encoding='utf-8')))
    content = (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if options.check:
        if OUTPUT.read_bytes() != content:
            raise SystemExit(f'{OUTPUT.name} differs from the generated suggestions')
    else:
        OUTPUT.write_bytes(content)
    grouped = sum(len(group['catalogIds']) for group in result['groups'])
    print(f'{len(result["groups"])} candidate groups, {grouped} linked variants, '
          f'{result["cardCount"] - grouped} independent variants')


if __name__ == '__main__':
    main()
