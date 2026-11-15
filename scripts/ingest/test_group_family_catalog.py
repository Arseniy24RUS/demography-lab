import json
import unittest

from group_family_catalog import CATALOG, OUTPUT, propose_groups, without_region


class PracticeGroupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
        cls.result = propose_groups(cls.catalog)
        cls.cards = {card['id']: card for card in cls.catalog['measures']}
        cls.groups = {group['id']: group for group in cls.result['groups']}
        cls.group_for = {
            catalog_id: group['id']
            for group in cls.result['groups']
            for catalog_id in group['catalogIds']
        }

    def test_pinned_catalogue_and_disjoint_regional_groups(self):
        self.assertEqual(self.result, json.loads(OUTPUT.read_text(encoding='utf-8')))
        self.assertEqual(self.result['cardCount'], len(self.cards))
        grouped = [card_id for group in self.groups.values() for card_id in group['catalogIds']]
        self.assertEqual(len(grouped), len(set(grouped)))
        for group in self.groups.values():
            variants = [self.cards[card_id] for card_id in group['catalogIds']]
            self.assertEqual({card['level'] for card in variants}, {'regional'})
            self.assertGreater(len({card['region'] for card in variants}), 1)

    def test_maternal_capital_aliases_preserve_variants_and_separate_other_forms(self):
        family = 'regional-maternal-capital'
        for card_id in (
            'sovetmam:reg-altayskiy-kray-001', 'sovetmam:ulyan-011', 'sovetmam:saha-015',
            'sovetmam:chuv-030', 'sovetmam:hmao-001', 'sovetmam:mgd-009', 'sovetmam:mgd-011',
        ):
            self.assertEqual(self.group_for[card_id], family)
        for card_id in (
            'sovetmam:materinskiy-kapital', 'sovetmam:matkapital-ot-rabotodatelya',
            'sovetmam:reg-altayskiy-kray-002', 'sovetmam:ivn-007', 'sovetmam:spb-014',
            'sovetmam:oren-002', 'sovetmam:pnz-002', 'sovetmam:yamal-044',
        ):
            self.assertNotEqual(self.group_for.get(card_id), family)

    def test_land_cash_and_choice_are_different_mechanisms(self):
        for card_id, family in (
            ('sovetmam:brn-017', 'regional-large-family-land'),
            ('sovetmam:brn-014', 'regional-large-family-land-payment'),
            ('sovetmam:ivn-012', 'regional-large-family-land-or-payment'),
            ('sovetmam:yarosl-028', 'regional-kindergarten-fee-waiver-svo'),
            ('sovetmam:yarosl-020', 'regional-kindergarten-fee-compensation'),
        ):
            self.assertEqual(self.group_for[card_id], family)

    def test_repeated_title_is_not_enough_for_generic_or_different_support(self):
        self.assertTrue(any(group['kind'] == 'same-title' for group in self.groups.values()))
        for card_id in ('sovetmam:vld-009', 'sovetmam:hak-001', 'sovetmam:hmao-002'):
            self.assertNotEqual(self.group_for.get(card_id), 'regional-in-kind-newborn-kit')
        generic = [card['id'] for card in self.cards.values() if without_region(card) == 'Пособие на ребёнка']
        self.assertGreaterEqual(len(generic), 2)
        self.assertTrue(all(card_id not in self.group_for for card_id in generic))
        self.assertEqual(self.group_for['sovetmam:mrm-008'], 'regional-in-kind-newborn-kit')


if __name__ == '__main__':
    unittest.main()
