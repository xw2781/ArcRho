"""Probe ResQ's random numbers and consolidation ranks over COM, black-box.

Research tool for step 2 of docs/plans/completed/bootstrap_and_stochastic_consolidation.md.
It compares inputs with outputs only; it never inspects ResQ's binaries.

NOTHING IS SAVED. Every setting this tool changes is made on a method loaded in
memory; ``Save`` is never called, and the reserving class is unloaded at the
end, so the ResQ database is untouched. Server PC only (ResQ COM, early
binding), run outside the sandbox with ``py -3.10``.

Two modes, each writing one JSON file::

    py -3.10 tools/resq_random_probe.py draws --seed 1 --sims 5 --out temp/draws.json
        On COL "F 72B" (estimation variance None unless --estimation is given,
        process variance Normal unless --process is given, prevent-negative
        off) simulate and dump every simulated incremental cell, the
        per-simulation development factors and latest simulated diagonal, and
        the reserves by origin. With estimation None and a Normal forecast each
        future cell is its mean plus a scaled standard-normal draw, so the
        draws can be backed out exactly.

    py -3.10 tools/resq_random_probe.py ranks --correlation 2 --dependency 0 --seed 1 \\
            [--dof 20] [--matrix temp/m.json] --out temp/ranks.json
        On the Total consolidation set the correlation type (0 independent,
        1 fully correlated, 2 specified, 3 as it comes), the dependency type
        (0 normal, 1 uniform, 2 gamma, 3 Student's T), degrees of freedom, the
        seed and optionally a full target matrix (JSON list of lists), then
        consolidate in memory and dump the target, adjusted and achieved
        matrices and every consolidation rank; --by-class N adds each
        segment's total in the first N consolidated simulations.

Findings (2026-09-23) are written up in the plan's "Random numbers" and "How
ResQ consolidates" sections.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from win32com.client import gencache

PROJECT = "NJ_Annual_Prod_202605_Fake"
BASE = r"PRNJ - PA\PA\All States\Direct Group"
DRAW_CLASS = "COL"
DRAW_METHOD = "F 72B - Bootstrap Net Incurred no PV"
TOTAL_CLASS = "Total"
CONSOLIDATION = "F 72 A - Bootstrap Consolidation Net Incurred with PV"
CONFIG = r"E:/ArcRho Server/config/config.json"


def connect():
    cfg = json.load(open(CONFIG))["resq"]
    app = gencache.EnsureDispatch("ResQ3Automation.ResQApplication")
    app.ConnectByName(cfg["connection_name"], cfg["user_name"], cfg["password"])
    return app


def reserving_class(app, name):
    return app.Projects().Item(PROJECT).ReservingClasses().Item(BASE + "\\" + name)


def draws(args):
    app = connect()
    rc = reserving_class(app, args.cls)
    try:
        b = rc.GetBootStrapMethod(args.method)
        W, N = int(b.OriginCount), int(b.TotalDevelopmentCount)
        b.EstimationVariance = args.estimation
        b.ProcessVariance = args.process
        b.PreventNegativeData = False
        b.SimulationCount = args.sims
        b.RandomSeed = args.seed
        t = time.time()
        b.Simulate()
        took = time.time() - t
        S = args.sims
        out = {
            "class": args.cls, "method": args.method, "seed": args.seed, "sims": S,
            "estimation": args.estimation, "process": args.process, "W": W, "N": N,
            "simulate_seconds": took,
            "scale_forecast": [float(b.ScaleValues_Forecasting(d, 3)) for d in range(1, N + 1)],
            "selected_scale_forecast": [float(b.SelectedScaleValues_Forecasting(d)) for d in range(1, N + 1)],
            "use_normal_on_negative_mean": bool(b.UseNormalOnNegMean),
            "odp_negative_mean_option": int(b.ODP_NegativeMeanOption),
            "bias_adjustment": int(b.BiasAdjustment),
            "latest_actual": [float(b.LatestValues(o)) for o in range(1, W + 1)],
            "cells": [[[float(b.SimulatedReserveDevelopment(o, d, s)) for d in range(1, N + 1)]
                       for o in range(1, W + 1)] for s in range(1, S + 1)],
            "factors": [[float(b.DevelopmentFactors(d, s)) for d in range(1, N)] for s in range(1, S + 1)],
            "latest": [[float(b.LatestSimulatedDiagonalValues(o, s)) for o in range(1, W + 1)]
                       for s in range(1, S + 1)],
            "reserves": [[float(b.UnscaledReserves.SimulatedValue(o, s)) for o in range(0, W + 1)]
                         for s in range(1, S + 1)],
        }
    finally:
        rc.UnloadChildren()
    return out


def ranks(args):
    app = connect()
    rc = reserving_class(app, TOTAL_CLASS)
    try:
        c = rc.GetBootStrapConsolidation(CONSOLIDATION)
        m = int(c.IncludedMethodCount)
        c.CorrelationType = args.correlation
        c.DependencyType = args.dependency
        c.DegreesOfFreedom = args.dof
        c.RandomSeed = args.seed
        if args.matrix:
            target = json.loads(Path(args.matrix).read_text())
            for i in range(m):
                for j in range(m):
                    if i != j:
                        c.SetMethodCorrelations(i + 1, j + 1, float(target[i][j]))
        t = time.time()
        c.Consolidate()
        took = time.time() - t
        n = int(c.SimulationCount)

        def matrix(getter):
            return [[float(getter(i, j)) for j in range(1, m + 1)] for i in range(1, m + 1)]

        out = {
            "correlation": args.correlation, "dependency": args.dependency, "dof": args.dof,
            "seed": args.seed, "methods": m, "sims": n, "consolidate_seconds": took,
            "target": matrix(c.MethodCorrelations),
            "adjusted": matrix(c.MethodCorrelations_Adjusted),
            "achieved_rank": matrix(c.MethodCorrelations_AchievedRank),
            "achieved_linear": matrix(c.MethodCorrelations_AchievedLinear),
            "ranks": [[int(c.ConsolidationRanks(i, s)) for s in range(1, n + 1)] for i in range(1, m + 1)],
        }
        if args.by_class:
            total = int(c.OriginCount) + 1   # origin n+1 is the total
            out["by_class_total_first_simulations"] = [
                [float(c.SimulatedReservesByClass(i, total, s)) for s in range(1, args.by_class + 1)]
                for i in range(1, m + 1)]
    finally:
        rc.UnloadChildren()
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="mode", required=True)
    d = sub.add_parser("draws")
    d.add_argument("--cls", default=DRAW_CLASS)
    d.add_argument("--method", default=DRAW_METHOD)
    d.add_argument("--seed", type=int, default=1)
    d.add_argument("--sims", type=int, default=5)
    d.add_argument("--estimation", type=int, default=0)
    d.add_argument("--process", type=int, default=2)
    d.add_argument("--out", required=True)
    r = sub.add_parser("ranks")
    r.add_argument("--correlation", type=int, default=2)
    r.add_argument("--dependency", type=int, default=0)
    r.add_argument("--dof", type=int, default=20)
    r.add_argument("--seed", type=int, default=1514684455)
    r.add_argument("--matrix")
    r.add_argument("--by-class", type=int, default=0,
                   help="also dump each segment's total in the first N consolidated simulations")
    r.add_argument("--out", required=True)
    args = p.parse_args()
    out = draws(args) if args.mode == "draws" else ranks(args)
    Path(args.out).write_text(json.dumps(out))
    print(f"{args.mode}: wrote {args.out}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
