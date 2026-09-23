"""Pin how ResQ's Stochastic Consolidation combines its segments.

``fixtures/resq_bootstrap_consolidation_total.json.gz`` was captured from ResQ
by ``tools/resq_bootstrap_capture.py``: five saved segment bootstraps and the
Total consolidation of the fake project. These tests state the combination rule
before any Arco consolidation code exists, so that code has a fixed target.
"""
from __future__ import annotations

import gzip
import json
import math
import unittest
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "resq_bootstrap_consolidation_total.json.gz"
REL_TOL = 1e-9


def load_fixture():
    with gzip.open(FIXTURE, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def pearson(x, y):
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    return sxy / math.sqrt(sxx * syy)


class ResQConsolidationRuleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = load_fixture()
        cls.cons = fixture["consolidation"]
        by_class = {s["reserving_class"].rsplit("\\", 1)[-1]: s for s in fixture["segments"]}
        cls.segments = [by_class[m["reserving_class"]] for m in cls.cons["included_methods"]]
        cls.n = cls.cons["settings"]["simulation_count"]
        # simulation (0-based position) holding each rank, per segment
        cls.sim_at_rank = []
        for seg in cls.segments:
            lookup = [None] * (cls.n + 1)
            for sim, rank in enumerate(seg["scaled_total_rank"]):
                lookup[rank] = sim
            cls.sim_at_rank.append(lookup)

    def segment_total_at(self, k, sim):
        """Segment k's scaled total reserve from the simulation ResQ ranked for consolidated simulation `sim`."""
        rank = self.cons["consolidation_ranks"][k][sim]
        return self.segments[k]["scaled_total_by_simulation"][self.sim_at_rank[k][rank]]

    def test_ranks_are_permutations_with_rank_one_smallest(self):
        for seg in self.segments:
            self.assertEqual(sorted(seg["scaled_total_rank"]), list(range(1, self.n + 1)))
            ordered = [seg["scaled_total_by_simulation"][sim] for sim in sorted(range(self.n), key=lambda s: seg["scaled_total_rank"][s])]
            self.assertEqual(ordered, sorted(ordered))
        for row in self.cons["consolidation_ranks"]:
            self.assertEqual(sorted(row), list(range(1, self.n + 1)))

    def test_rule_three_consolidated_total_is_the_sum_of_segments_at_the_assigned_ranks(self):
        factors = [m["factor"] for m in self.cons["included_methods"]]
        totals = self.cons["scaled_total_by_simulation"]
        self.assertEqual(len(totals), self.n)
        for sim in range(self.n):
            expected = sum(f * self.segment_total_at(k, sim) for k, f in enumerate(factors))
            self.assertLessEqual(abs(totals[sim] - expected), REL_TOL * max(1.0, abs(expected)), f"simulation {sim + 1}")

    def test_the_whole_origin_vector_moves_with_the_rank(self):
        for sim, per_method in enumerate(self.cons["reserves_by_class_first_simulations"]):
            for k, origins in enumerate(per_method):
                self.assertAlmostEqual(origins[-1], self.segment_total_at(k, sim), delta=REL_TOL * max(1.0, abs(origins[-1])))
                self.assertAlmostEqual(sum(origins[:-1]), origins[-1], delta=1e-6 * max(1.0, abs(origins[-1])))
                rank_sim = self.sim_at_rank[k][self.cons["consolidation_ranks"][k][sim]]
                if rank_sim < len(self.segments[k]["scaled_by_origin_first_simulations"]):
                    for got, want in zip(origins[:-1], self.segments[k]["scaled_by_origin_first_simulations"][rank_sim]):
                        self.assertAlmostEqual(got, want, delta=REL_TOL * max(1.0, abs(want)))

    def test_adjusted_correlation_is_two_sine_pi_rho_over_six(self):
        for target_row, adjusted_row in zip(self.cons["target_correlations"], self.cons["adjusted_correlations"]):
            for rho, adjusted in zip(target_row, adjusted_row):
                expected = 2.0 * math.sin(math.pi * rho / 6.0)
                self.assertAlmostEqual(adjusted, expected, delta=1e-6)

    def test_achieved_correlations_are_rank_and_linear_correlations_of_the_combined_segments(self):
        ranks = self.cons["consolidation_ranks"]
        reserves = [[self.segment_total_at(k, sim) for sim in range(self.n)] for k in range(len(self.segments))]
        for i, j in ((0, 4), (1, 2), (0, 1)):
            self.assertAlmostEqual(pearson(ranks[i], ranks[j]), self.cons["achieved_rank_correlations"][i][j], delta=1e-9)
            self.assertAlmostEqual(pearson(reserves[i], reserves[j]), self.cons["achieved_linear_correlations"][i][j], delta=1e-9)

    def test_every_segment_passed_the_plausibility_check(self):
        for seg in self.segments:
            self.assertTrue(seg["plausibility"]["passed"], seg["reserving_class"])


if __name__ == "__main__":
    unittest.main()
