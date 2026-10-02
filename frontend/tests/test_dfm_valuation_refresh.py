from __future__ import annotations

import json
import unittest
from unittest.mock import patch

import test_dfm_service as fixtures
from arcrho_api.dfm_contract import recalculate_dfm_method
from app_server.services import dfm_service


class DfmValuationRefreshTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.DfmServiceTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.method = self.fixture.method_payload()
        self.method['ratios_tab']['ratio_triangle']['excluded'][0][0] = 1
        self.method = recalculate_dfm_method(self.method)
        self.fixture.write_method_pair(self.method)
        self.fixture.write_source('Paid', '100,175\n200,\n', data_format='Triangle',
                                  dependents=['Development Output'])
        source_path = self.fixture.sidecars / 'Paid.json'
        source = json.loads(source_path.read_text())
        source['source_kind'] = 'engine'
        self.fixture.write_json(source_path, source)
        self.before = (self.fixture.methods / 'DFM@Development.json').read_bytes()

    def test_refresh_publishes_current_labels_and_keeps_patterns(self):
        with patch('app_server.services.arcrho_runtime_service.get_project_headers',
                   return_value={'ok': True, 'labels': ['13m', '25m']}) as headers:
            result = dfm_service.refresh_dependents('Project', 'Class', ['Paid'])
        self.assertTrue(result['ok'], result)
        headers.assert_called_once_with('Project', 12,
                                        timeout_sec=dfm_service.config.ENGINE_REQUEST_TIMEOUT_SEC,
                                        period_type=1)
        saved = json.loads((self.fixture.methods / 'DFM@Development.json').read_text())
        self.assertEqual(saved['data_tab']['development_labels'], ['13m', '25m'])
        self.assertEqual(saved['data_tab']['input_data_triangle_values'][0], [100, 175])
        ratio = saved['ratios_tab']['ratio_triangle']
        self.assertEqual(ratio['development_labels'], ['(1) 13-25', '25 - Ult'])
        self.assertEqual(ratio['ratio_values'][0][0], 1.75)
        self.assertEqual(ratio['excluded'], self.method['ratios_tab']['ratio_triangle']['excluded'])
        self.assertEqual(saved['ratios_tab']['average_formulas']['selected'],
                         self.method['ratios_tab']['average_formulas']['selected'])
        sidecar = json.loads((self.fixture.sidecars / 'Development Output.json').read_text())
        self.assertEqual(sidecar['status'], 2)

    def test_header_failure_keeps_last_publication(self):
        with patch('app_server.services.arcrho_runtime_service.get_project_headers',
                   return_value={'ok': False, 'message': 'Headers unavailable'}):
            result = dfm_service.refresh_dependents('Project', 'Class', ['Paid'])
        self.assertFalse(result['ok'])
        self.assertIn('Headers unavailable', result['errors'][0]['reason'])
        self.assertEqual((self.fixture.methods / 'DFM@Development.json').read_bytes(), self.before)

    def test_monthly_manual_rollup_uses_current_project_development_labels(self):
        self.fixture.write_monthly_source('Paid', dependents=['Development Output'])
        with patch('app_server.services.arcrho_runtime_service.get_project_headers',
                   return_value={'ok': True, 'labels': ['9m', '21m']}):
            result = dfm_service.refresh_dependents('Project', 'Class', ['Paid'])
        self.assertTrue(result['ok'], result)
        saved = json.loads((self.fixture.methods / 'DFM@Development.json').read_text())
        self.assertEqual(saved['data_tab']['development_labels'], ['9m', '21m'])
        self.assertEqual(saved['ratios_tab']['average_formulas']['selected'],
                         self.method['ratios_tab']['average_formulas']['selected'])

    def test_method_source_uses_its_published_labels(self):
        p = self.fixture.sidecars / 'Paid.json'
        source = json.loads(p.read_text())
        source.update(source_kind='berquist_sherman_sr', development_labels=['9m', '21m'])
        self.fixture.write_json(p, source)
        result = dfm_service.refresh_dependents('Project', 'Class', ['Paid'])
        self.assertTrue(result['ok'], result)
        saved = json.loads((self.fixture.methods / 'DFM@Development.json').read_text())
        self.assertEqual(saved['data_tab']['development_labels'], ['9m', '21m'])

    def test_empty_rolled_up_input_preserves_last_publication(self):
        self.fixture.write_monthly_source('Paid', dependents=['Development Output'])
        with patch.object(dfm_service.precedent_cache_service, 'rollup_rows',
                          return_value=[[None, None], [None, None]]):
            result = dfm_service.refresh_dependents('Project', 'Class', ['Paid'])
        self.assertFalse(result['ok'])
        self.assertIn('no values at the project', result['errors'][0]['reason'])
        self.assertEqual((self.fixture.methods / 'DFM@Development.json').read_bytes(), self.before)


if __name__ == '__main__':
    unittest.main()
