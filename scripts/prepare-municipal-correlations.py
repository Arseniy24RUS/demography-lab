"""Prepare municipality-level BDMO fertility associations from a verified offline snapshot."""
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import math
import sqlite3
import tempfile
import time
from pathlib import Path
from statistics import NormalDist

import duckdb


RELEASE = "112_v20260928"
SOURCE_MANIFEST_SHA256 = "9edaba16e1c34e4873737fbe4a496c21ede18e9a4ee0c3d1e68fc23963a00c50"
OUTCOME_CODE = "Y48112007"
OUTCOME_UNIT = "Промилле (0,1 процента)"
ANNUAL = "Значение показателя за год"
MUNICIPAL_LEVELS = {
    "upper": "Муниципальное образование верхнего уровня",
    "lower": "Муниципальное образование нижнего уровня",
}
MIN_PAIRS = 4
FISHER_CLAMP = 1 - 1e-12
Z95 = NormalDist().inv_cdf(0.975)
METADATA = frozenset({
    "indicator_section_code", "indicator_section", "indicator_code", "indicator_name",
    "region_id", "region_name", "mun_level", "mun_district", "municipality", "oktmo",
    "mun_type", "mun_type_oktmo", "oktmo_stable", "oktmo_history", "oktmo_year_from",
    "oktmo_year_to", "year", "indicator_value", "indicator_unit", "indicator_period", "comment",
})
# Separate every comparable reported period, including annual, monthly, quarterly
# and fixed-date values. Missing service markers do not define a reference period.
MISSING_PERIODS = ("", "CD", "UD", "ND", "NA", "N/A", "NULL", "NONE")


def sha256_file(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def write_json(path: Path, obj: object) -> str:
    body = (
        json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    ).encode("utf-8")
    with path.open("xb") as file:
        if path.suffix == ".gz":
            with gzip.GzipFile(filename="", mode="wb", fileobj=file, compresslevel=6, mtime=0) as zipped:
                zipped.write(body)
        else:
            file.write(body)
    return sha256_file(path)


def quoted_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def verified_sections(package: Path) -> tuple[str, dict[int, tuple[Path, dict]]]:
    manifest = package / "manifest.json"
    digest = sha256_file(manifest)
    if digest != SOURCE_MANIFEST_SHA256:
        raise ValueError(f"Expected the verified BDMO snapshot {RELEASE}")
    parsed = json.loads(manifest.read_text(encoding="utf-8"))
    if parsed.get("schema") != "omnistat.data.v1":
        raise ValueError("Expected a prepared immutable OmniStat data package")
    result = {}
    for record in parsed["files"]:
        if record["kind"] != "bdmo":
            continue
        section = int(record["section_code"])
        if section in result or record["path"] != f"bdmo/bdmo_{section}.parquet":
            raise ValueError(f"Unexpected section path or duplicate section: {section}")
        path = package / record["path"]
        if path.stat().st_size != record["bytes"] or sha256_file(path) != record["sha256"]:
            raise ValueError(f"Section {section} failed source verification")
        result[section] = (path, record)
    if len(result) != 33 or 31 not in result:
        raise ValueError("Expected all 33 sections of BDMO")
    return digest, result


def crosswalk_ids(path: Path | None) -> tuple[dict, dict]:
    if path is None:
        return {}, {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    candidates = collections.defaultdict(set)
    regions = collections.defaultdict(set)
    for row in raw["records"]:
        if row["status"] != "matched":
            continue
        key = tuple(row[field] for field in (
            "bdmoRegionId", "bdmoRegionName", "bdmoOktmo", "bdmoType",
        ))
        candidates[key].add((row["territoryKey"], row["regionId"]))
        regions[key[:2]].add(row["regionId"])
    return (
        {key: next(iter(matches)) for key, matches in candidates.items() if len(matches) == 1},
        {key: next(iter(matches)) for key, matches in regions.items() if len(matches) == 1},
    )


def load_outcomes(db: duckdb.DuckDBPyConnection, path: Path, municipal_level: str) -> tuple[list[dict], dict]:
    db.execute("""
        CREATE TEMP TABLE outcome_cells AS
        SELECT region_id, region_name, oktmo, mun_type, year,
               min(municipality) AS name, min(mun_district) AS district,
               list(DISTINCT oktmo_stable) AS stable_codes,
               list(DISTINCT oktmo_history) AS boundary_history,
               min(indicator_value) AS y, max(indicator_value) AS max_y, count(*) AS raw_rows
        FROM read_parquet(?)
        WHERE indicator_code = ? AND indicator_period = ? AND indicator_unit = ?
          AND mun_level = ? AND mun_type = mun_type_oktmo
          AND year BETWEEN 1900 AND 2100
          AND regexp_full_match(region_id, '[0-9]{2,3}')
          AND regexp_full_match(oktmo, '[0-9]{8}')
          AND region_name IS NOT NULL AND municipality IS NOT NULL
          AND isfinite(indicator_value) AND indicator_value >= 0
          AND grup_2 = 'CD' AND vozr = 'CD' AND migr = 'CD' AND mest = 'CD' AND nazsostv = 'CD'
        GROUP BY 1, 2, 3, 4, 5
        """, [str(path), OUTCOME_CODE, ANNUAL, OUTCOME_UNIT, municipal_level])
    db.execute("""
        CREATE TEMP TABLE locations AS
        SELECT row_number() OVER (ORDER BY region_id, region_name, oktmo, mun_type) AS id,
               region_id, region_name, oktmo, mun_type, name, district, observed_years,
               stable_codes, boundary_history
        FROM (
            SELECT region_id, region_name, oktmo, mun_type,
                   arg_max(name, year) AS name, arg_max(district, year) AS district,
                   list(year ORDER BY year) AS observed_years,
                   list_distinct(flatten(list(stable_codes))) AS stable_codes,
                   list_distinct(flatten(list(boundary_history))) AS boundary_history
            FROM outcome_cells WHERE y = max_y GROUP BY 1, 2, 3, 4
        )
        """)
    db.execute("""
        CREATE TEMP TABLE outcomes AS
        SELECT l.id, o.region_id, o.region_name, o.oktmo, o.mun_type, o.year, o.y
        FROM outcome_cells o JOIN locations l USING (region_id, region_name, oktmo, mun_type)
        WHERE o.y = o.max_y
        """)
    target = [{
        "id": id_, "sourceRegionId": region, "regionName": region_name, "oktmo": code,
        "munType": mu_type, "name": name, "munDistrict": district, "years": years,
        "stableCodes": sorted(stable), "boundaryHistory": sorted(history),
    } for id_, region, region_name, code, mu_type, name, district, years, stable, history in db.execute(
        "SELECT * FROM locations ORDER BY id"
    ).fetchall()]
    if not target:
        raise ValueError("No verified fertility outcomes in source section 31")
    invalid, agreeing, raw_rows = db.execute("""
        SELECT count(*) FILTER (WHERE y <> max_y),
               coalesce(sum(raw_rows - 1) FILTER (WHERE y = max_y), 0),
               coalesce(sum(raw_rows), 0)
        FROM outcome_cells
        """).fetchone()
    start, end = db.execute("SELECT min(year), max(year) FROM outcomes").fetchone()
    if end - start > 51:
        raise ValueError("The year range exceeds the browser-safe integer bitmask")
    return target, {
        "yearStart": start, "yearEnd": end, "conflictedOutcomeCells": invalid,
        "duplicateOutcomeRows": agreeing, "rawOutcomeRows": raw_rows,
    }


def posterior_for(r: float, n: int) -> tuple[float, float, float, float]:
    # Fisher z approx: z_hat | z ~ Normal(z, 1/(n-3)); prior z ~ Normal(0, 1).
    # Back-transform posterior quantiles, which are equivariant under tanh.
    r = max(-1.0, min(1.0, r))
    estimate = math.atanh(max(-FISHER_CLAMP, min(FISHER_CLAMP, r)))
    mean = estimate * (n - 3) / (n - 2)
    margin = Z95 / math.sqrt(n - 2)
    return r, math.tanh(mean), math.tanh(mean - margin), math.tanh(mean + margin)


def build_section(db, spool, path, section, year_start, definitions, municipal_level):
    cols = [
        row[0] for row in db.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]
        ).fetchall()
    ]
    missing = METADATA - set(cols)
    if missing:
        raise ValueError(f"Section {section} missing expected columns: {sorted(missing)}")
    dims = sorted(set(cols) - METADATA)
    dim_fields = ", ".join(f"p.{quoted_identifier(dim)}" for dim in dims)
    dim_select = f", {dim_fields}" if dims else ""

    # Join to annual observed outcomes before grouping. Code/title/unit/period and
    # every available source dimension define an indicator series. Distinct values
    # within a cell conflict and are excluded jointly with that year's outcome.
    db.execute(f"""
        CREATE TEMP TABLE cells AS
        SELECT o.id, o.year, o.y, p.indicator_code, p.indicator_name,
               p.indicator_section, p.indicator_unit, p.indicator_period
               {dim_select},
               min(p.indicator_value) AS x, max(p.indicator_value) AS max_x,
               count(*) AS raw_rows
        FROM read_parquet(?) p
        JOIN outcomes o USING (region_id, region_name, oktmo, mun_type, year)
        WHERE p.mun_level = ? AND p.mun_type = p.mun_type_oktmo
          AND p.indicator_code <> ?
          AND p.indicator_code IS NOT NULL AND p.indicator_name IS NOT NULL
          AND p.indicator_period IS NOT NULL
          AND upper(trim(p.indicator_period)) NOT IN (SELECT unnest(?))
          AND isfinite(p.indicator_value)
        GROUP BY ALL
        """, [str(path), municipal_level, OUTCOME_CODE, list(MISSING_PERIODS)])
    eligible, invalid, duplicates, source_rows = db.execute("""
        SELECT count(*), count(*) FILTER (WHERE x <> max_x),
               coalesce(sum(raw_rows - 1) FILTER (WHERE x = max_x), 0),
               coalesce(sum(raw_rows), 0)
        FROM cells
        """).fetchone()
    source_codes = {row[0] for row in db.execute(
        "SELECT DISTINCT indicator_code FROM read_parquet(?) WHERE indicator_code IS NOT NULL",
        [str(path)],
    ).fetchall()}
    paired_codes = {row[0] for row in db.execute(
        "SELECT DISTINCT indicator_code FROM cells WHERE x = max_x"
    ).fetchall()}
    estimated_codes = set()
    dim_aliases = ", ".join(quoted_identifier(dim) for dim in dims)
    dim_output = f", {dim_aliases}" if dims else ""
    query = db.execute(f"""
        SELECT id, indicator_code, indicator_name, indicator_section,
               indicator_unit, indicator_period {dim_output},
               count(*) AS n, bit_or(1::BIGINT << (year - ?)) AS mask,
               corr(x, y) AS pearson
        FROM cells WHERE x = max_x
        GROUP BY ALL
        HAVING n >= ? AND min(x) < max(x) AND min(y) < max(y)
        ORDER BY ALL
        """, [year_start, MIN_PAIRS])
    total = 0
    failed_numeric = 0
    while found := query.fetchmany(20_000):
        inserts = []
        for id_, code, title, section_name, unit, period, *rest in found:
            n, mask, corr = rest[-3:]
            if corr is None or not math.isfinite(corr):
                failed_numeric += 1
                continue
            dimensions = tuple(
                (dim, '[не указано]' if value is None else '[пусто]' if value == '' else str(value))
                for dim, value in zip(dims, rest[:-3], strict=True)
                if value != "CD"
            )
            # Null, empty and CD are kept distinct in the calculation. In the unusual
            # case they would yield a duplicate label, retain the missing-token label.
            signature = (section, code, title, section_name, unit, period, tuple(rest[:-3]))
            metric = definitions.get(signature)
            if metric is None:
                metric = {
                    "id": len(definitions), "code": code, "title": title, "section": section,
                    "sectionName": section_name, "unit": unit or "", "period": period,
                    "dimensions": dimensions,
                }
                definitions[signature] = metric
            r, median, lo, hi = posterior_for(corr, n)
            estimated_codes.add(code)
            inserts.append((id_, metric["id"], n, mask, r, median, lo, hi))
        spool.executemany("INSERT INTO factors VALUES (?,?,?,?,?,?,?,?)", inserts)
        total += len(inserts)
    spool.commit()
    db.execute("DROP TABLE cells")
    return {
        "section": section, "dimensions": dims, "pairedCandidateRows": source_rows,
        "pairedCells": eligible, "conflictingCells": invalid, "identicalDuplicateRows": duplicates,
        "factors": total, "nonFiniteCorrelations": failed_numeric,
        "sourceIndicatorCodes": sorted(source_codes), "pairedIndicatorCodes": sorted(paired_codes),
        "estimatedIndicatorCodes": sorted(estimated_codes),
    }


def write_public(out, spool, targets, definitions, outcome_qa, manifest_sha, crosswalk, level):
    out.mkdir(parents=True)
    (out / "municipalities").mkdir()
    mun_ids, region_ids = crosswalk_ids(crosswalk)
    territories = []
    rows_total = 0
    biggest = 0
    for item in targets:
        target_id = item["id"]
        scope = tuple(item[key] for key in ("sourceRegionId", "regionName", "oktmo", "munType"))
        suffix = hashlib.sha256("\0".join(scope).encode()).hexdigest()[:10]
        key = f'{item["sourceRegionId"]}-{item["oktmo"]}-{suffix}'
        app_territory, app_region = mun_ids.get(scope, (None, region_ids.get(scope[:2])))
        if level == "lower":
            key = "l-" + key
            app_territory = None
        rows = [
            [metric_id, n, mask, *[round(x, 6) for x in (r, median, low, high)]]
            for metric_id, n, mask, r, median, low, high in spool.execute("""
                SELECT metric,n,mask,r,posterior_median,lo,hi
                FROM factors WHERE id=? ORDER BY abs(posterior_median) DESC, metric
                """, (target_id,))
        ]
        rows_total += len(rows)
        location = {
            **{name: value for name, value in item.items() if name != "id" and
               (name != "munDistrict" or level == "lower")},
            "key": key, "regionId": app_region or f'bdmo-{item["sourceRegionId"]}',
            "nFactors": len(rows), "path": None, "sha256": None,
        }
        if app_territory:
            location["territoryKey"] = app_territory
        if rows:
            filename = f"municipalities/{key}.json.gz"
            location["path"] = filename
            location["sha256"] = write_json(
                out / filename, {"schemaVersion": 1, "key": key, "rows": rows}
            )
            biggest = max(biggest, (out / filename).stat().st_size)
        territories.append(location)

    counts = {
        "municipalities": len(territories),
        "municipalitiesWithFactors": sum(t["nFactors"] > 0 for t in territories),
        "sourceRegions": len({t["sourceRegionId"] for t in territories}),
        "indicators": len({m["code"] for m in definitions.values()}),
        "metrics": len(definitions),
        "factors": rows_total,
        "largestShardBytes": biggest,
    }
    manifest = {
        "schemaVersion": 1, **({"level": "lower"} if level == "lower" else {}),
        "sourceRelease": RELEASE, "sourceManifestSha256": manifest_sha,
        "yearStart": outcome_qa["yearStart"], "yearEnd": outcome_qa["yearEnd"],
        "outcome": {"code": OUTCOME_CODE, "title": "Общий коэффициент рождаемости", "unit": "‰"},
        "method": {
            "id": "fisher-z-normal-posterior-v1", "priorZMean": 0, "priorZSD": 1,
            "samplingVariance": "1/(n-3)", "minPairs": MIN_PAIRS, "intervalLevel": 0.95,
            "fisherClamp": FISHER_CLAMP,
            "periods": sorted({m["period"] for m in definitions.values()}),
            "periodPolicy": "same_reported_period_across_years",
            "excludedPeriodMarkers": list(MISSING_PERIODS),
            "scope": f"canonical_{level}_municipality_reported_oktmo",
            "pairing": "complete_same_calendar_year", "ranking": "absolute_posterior_median",
        },
        "columns": ["metricId", "n", "yearsMask", "r", "posteriorMedian", "low", "high"],
        "counts": counts, "metrics": list(definitions.values()), "territories": territories,
    }
    counts["indexSha256"] = write_json(out / "index.json.gz", manifest)
    counts["compressedBytes"] = sum(p.stat().st_size for p in out.rglob("*.json.gz"))
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--qa", type=Path, required=True)
    parser.add_argument("--crosswalk", type=Path)
    parser.add_argument("--level", choices=MUNICIPAL_LEVELS, default="upper")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    out, qa = args.out.resolve(), args.qa.resolve()
    if out.exists() or qa.exists() or not out.parent.is_dir():
        parser.error("Use fresh output and QA destinations in an existing staging parent")
    if out.is_relative_to(args.package.resolve()) or qa.is_relative_to(out):
        parser.error("Keep the verified source and private QA separate from public assets")
    municipal_level = MUNICIPAL_LEVELS[args.level]
    start = time.monotonic()
    manifest_sha, sections = verified_sections(args.package.resolve())
    aggregate = []
    definitions = {}
    with tempfile.TemporaryDirectory(prefix="bdmo-factors-work-", dir=out.parent) as work:
        scratch = Path(work)
        db = duckdb.connect(config={
            "threads": args.threads, "memory_limit": "5GB", "temp_directory": str(scratch / "duck")
        })
        db.execute("SET enable_progress_bar=false")
        spool = sqlite3.connect(scratch / "factors.db")
        try:
            spool.execute("""
                CREATE TABLE factors (
                    id INTEGER, metric INTEGER, n INTEGER, mask INTEGER,
                    r REAL, posterior_median REAL, lo REAL, hi REAL,
                    PRIMARY KEY(id, metric)
                ) WITHOUT ROWID
                """)
            targets, outcome_qa = load_outcomes(db, sections[31][0], municipal_level)
            print(json.dumps({"outcomeTerritories": len(targets), **outcome_qa}), flush=True)
            for section, (source, _) in sorted(sections.items()):
                report = build_section(
                    db, spool, source, section, outcome_qa["yearStart"], definitions, municipal_level
                )
                aggregate.append(report)
                print(json.dumps(report, ensure_ascii=False), flush=True)
            counts = write_public(
                out, spool, targets, definitions, outcome_qa, manifest_sha, args.crosswalk, args.level
            )
        finally:
            db.close()
            spool.close()
    source_indicator_codes = set().union(*(set(s["sourceIndicatorCodes"]) for s in aggregate))
    paired_indicator_codes = set().union(*(set(s["pairedIndicatorCodes"]) for s in aggregate))
    estimated_indicator_codes = set().union(*(set(s["estimatedIndicatorCodes"]) for s in aggregate))
    report = {
        "sourceManifestSha256": manifest_sha, "counts": counts, "outcome": outcome_qa,
        "indicatorAvailability": {
            "source": len(source_indicator_codes),
            "paired": len(paired_indicator_codes),
            "estimated": len(estimated_indicator_codes),
            "withoutPair": sorted(source_indicator_codes - paired_indicator_codes - {OUTCOME_CODE}),
            "pairedWithoutEstimate": sorted(paired_indicator_codes - estimated_indicator_codes),
        },
        "sections": aggregate, "elapsedSeconds": round(time.monotonic() - start, 1),
    }
    write_json(qa, report)
    print(json.dumps(report["counts"], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
