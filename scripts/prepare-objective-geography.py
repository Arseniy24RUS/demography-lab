"""Prepare regional fertility cards and the BDMO settlement hierarchy."""
from __future__ import annotations

import argparse
from collections import defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
from statistics import correlation
import unicodedata

from openpyxl import load_workbook


UPSTREAM = "https://github.com/Arseniy24RUS/Bayes-correlations-of-Russia"
REVISION = "5dcd222bc5f41a8b310cb4769df424d998c91b1a"
WORKBOOK = "corr_all_regions_all.xlsx"
WORKBOOK_SHA = "34ce357c6b7866c89d3eac13edea0096b070ca980f1c2d4d7f128cfe6dea61e2"
INPUT = "Итоговая_база_данных_типизация_и_исправления_финальные.xlsx"
INPUT_SHA = "858cd77afd0ed1fc0f6ffdd20c9c2158e82992c6bdeffa8efdc2e53003f753a4"
OUTCOME = "Суммарный коэффициент рождаемости (всего)"
ANNUAL = "Значение показателя за год"
REGIONAL_SCOPE = {
    "arkhangelskaia-oblast": "Архангельская область (без АО)",
    "kemerovskaia-oblast-kuzbass": "Кемеровская область - Кузбасс",
    "respublika-adygeia-adygeia": "Республика Адыгея",
    "tiumenskaia-oblast": (
        "Тюменская область (кроме Ханты-Мансийского автономного округа-Югры"
        " и Ямало-Ненецкого автономного округа)"
    ),
}
ALL_MIGRATION = [["grup_2", "Всего"], ["migr", "Миграция — всего"], ["vozr", "Всего"]]
COMMON_INDICATORS = {
    "Прибыло": ["Y48112021", "Человек", ANNUAL, ALL_MIGRATION],
    "Выбыло": ["Y48112022", "Человек", ANNUAL, ALL_MIGRATION],
    "Миграционное сальдо": ["Y48112023", "Человек", ANNUAL, ALL_MIGRATION],
    "Численность постоянного населения на 1 января": [
        "Y48112027", "Человек", "На 1 января", [["mest", "Все население"]],
    ],
    "Общая площадь жилых помещений на 1 жителя, кв. м": [
        "Y48211001", "Квадратный метр", ANNUAL, [],
    ],
}
SETTLEMENT_TYPES = {"Городское поселение", "Сельское поселение"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def read_catalog(path: Path):
    return json.loads(gzip.decompress(path.read_bytes()))


def write_catalog(path: Path, value) -> None:
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=6) as compressed:
            compressed.write(json_bytes(value) + b"\n")


def finite(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def name_key(value: str) -> str:
    text = unicodedata.normalize("NFC", value).casefold().replace("ё", "е")
    text = re.sub(r"^г\.\s+", "", text)
    return re.sub(r"\s*[-‐‑‒–—]\s*", "-", text)


def input_rows(path: Path) -> tuple[dict[str, int], dict[str, dict[int, tuple]]]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        rows = workbook.worksheets[0].values
        headers = {value: index for index, value in enumerate(next(rows)) if value}
        result = defaultdict(dict)
        for row in rows:
            region, year, unit_type = (row[headers[field]] for field in ("Регион", "Год", "Тип"))
            if unit_type != "Субъект РФ" and region != REGIONAL_SCOPE["kemerovskaia-oblast-kuzbass"]:
                continue
            if not isinstance(region, str) or type(year) is not int or year in result[region]:
                raise ValueError(f"Invalid or duplicate region-year cell: {region}, {year}")
            result[region][year] = row
        return headers, result
    finally:
        workbook.close()


def shared_keys(metrics: list[dict]) -> dict[str, str]:
    signatures = {
        json_bytes([row["code"], row["unit"], row["period"], sorted(row["dimensions"], key=lambda pair: pair[0])])
        for row in metrics
    }
    result = {}
    for title, signature in COMMON_INDICATORS.items():
        encoded = json_bytes(signature)
        if encoded not in signatures:
            raise ValueError(f"Missing BDMO equivalent: {title}")
        result[title] = "m-" + digest(encoded)
    return result


def correlation_rows(sheet, records, columns, aliases):
    table = list(sheet.values)
    if len(table) < 7 or table[0][:2] != ("Параметр", "Значение"):
        raise ValueError(f"Unexpected correlation sheet layout: {sheet.title}")
    outcome_row = next((row for row in table[6:] if row[0] == OUTCOME), None)
    if outcome_row is None:
        return [], 0

    rows, published_only = [], 0
    for title, estimate in zip(table[5][1:], outcome_row[1:], strict=True):
        if title == OUTCOME or not finite(estimate):
            continue
        paired = [
            (year, cells[columns[title]], cells[columns[OUTCOME]])
            for year, cells in sorted(records.items())
            if finite(cells[columns[title]]) and finite(cells[columns[OUTCOME]])
        ]
        n = len(paired)
        row = {
            "key": "r-" + digest(title.encode("utf-8")), "title": title,
            "coefficient": estimate, "years": [year for year, _, _ in paired],
        }
        if n < 3:
            # The released matrix still provides this estimate; input years are incomplete.
            row["publishedOnly"] = True
            published_only += 1
        else:
            _, indicator, fertility = zip(*paired, strict=True)
            pearson = correlation(indicator, fertility)
            adjusted = pearson * (1 - (1 - pearson**2) / (n - 2))
            if not math.isclose(estimate, adjusted, rel_tol=0, abs_tol=0.00050001):
                raise ValueError(f"Published estimate does not match paired data: {sheet.title}, {title}")
        if title in aliases:
            row["relationshipKey"] = aliases[title]
        rows.append(row)
    return sorted(rows, key=lambda row: (-abs(row["coefficient"]), row["title"])), published_only


def regional_catalog(upstream: Path, registry, municipal):
    results, source = upstream / WORKBOOK, upstream / INPUT
    if digest(results.read_bytes()) != WORKBOOK_SHA or digest(source.read_bytes()) != INPUT_SHA:
        raise ValueError(f"Expected the two workbooks from upstream revision {REVISION}")
    columns, observations = input_rows(source)
    by_name = {name_key(name): name for name in observations}
    if len(by_name) != len(observations):
        raise ValueError("Normalized names in the regional workbook are ambiguous")
    workbook = load_workbook(results, read_only=True, data_only=True)
    aliases = shared_keys(municipal["metrics"])
    regions, published_only = [], 0
    try:
        for region in registry:
            region_id, name = region["regionId"], region["name"]
            source_name = REGIONAL_SCOPE.get(region_id) or by_name[name_key(name)]
            title = source_name[:31]
            records = observations[source_name]
            if title in workbook.sheetnames:
                rows, n_published_only = correlation_rows(workbook[title], records, columns, aliases)
                published_only += n_published_only
            else:
                if any(finite(row[columns[OUTCOME]]) for row in records.values()):
                    raise ValueError(f"Region has fertility observations but no published sheet: {source_name}")
                rows = []
            regions.append({"regionId": region_id, "name": name, "sourceName": source_name, "rows": rows})
    finally:
        workbook.close()
    return {
        "schemaVersion": 1,
        "source": {
            "title": "Цифровая демографическая обсерватория",
            "url": UPSTREAM,
            "revision": REVISION,
            "workbookSha256": WORKBOOK_SHA,
            "inputSha256": INPUT_SHA,
            "outcome": {"title": OUTCOME, "unit": "Детей на одну женщину"},
        },
        "regions": regions,
        "counts": {
            "regions": len(regions),
            "regionsWithFactors": sum(bool(region["rows"]) for region in regions),
            "factors": sum(len(region["rows"]) for region in regions),
            "publishedOnly": published_only,
        },
    }


def settlement_catalog(upper, lower):
    def scope(row, code):
        return row["sourceRegionId"], row["regionName"], code

    municipality_scopes = defaultdict(list)
    for row in upper["territories"]:
        municipality_scopes[scope(row, row["oktmo"])].append(row)

    parents = {}
    counts = {"parents": 0, "settlements": 0, "settlementsWithFactors": 0, "excludedOtherUnits": 0}
    for child in lower["territories"]:
        # The trailing 100/400 codes are totals for all urban/rural settlements.
        if (child["munType"] not in SETTLEMENT_TYPES or child["oktmo"][-3:] in {"100", "400"}
            or child["name"].lower().startswith(("городские поселения ", "сельские поселения "))):
            counts["excludedOtherUnits"] += 1
            continue
        parent_code = child["oktmo"][:5] + "000"
        district = child["munDistrict"]
        candidates = municipality_scopes[scope(child, parent_code)]
        if len(candidates) == 1 and candidates[0]["name"] == district:
            municipality = candidates[0]
        elif not candidates and (child["sourceRegionId"], parent_code, district) == (
            "30", "30832000", "Тигильский муниципальный район"
        ):
            # This entry is a navigation parent from seven overlapping BDMO lower records.
            # The source has no upper fertility series for the historical district.
            municipality = {"key": "p-30-30832000", "regionId": child["regionId"], "name": district}
        else:
            raise ValueError(f"Ambiguous settlement parent: {child['key']} {district} ({parent_code})")
        if municipality["regionId"] != child["regionId"]:
            raise ValueError(f"Settlement and parent use different regions: {child['key']}")
        parent = parents.setdefault(municipality["key"], {
            "key": municipality["key"], "regionId": municipality["regionId"],
            "name": district, "oktmo": parent_code, "settlementKeys": [],
            **({"territoryKey": municipality["territoryKey"]} if municipality.get("territoryKey") else {}),
        })
        parent["settlementKeys"].append(child["key"])
        counts["settlements"] += 1
        counts["settlementsWithFactors"] += bool(child["nFactors"])
    counts["parents"] = len(parents)
    return {"schemaVersion": 1, "parents": list(parents.values()), "counts": counts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--data", type=Path, default=Path("public/data"))
    args = parser.parse_args()
    path = args.data / "factors"
    upper, lower = (read_catalog(path / name) for name in ("index.json.gz", "lower/index.json.gz"))
    registry = json.loads((args.data / "territories/registry.json").read_text(encoding="utf-8"))
    regions = [row for row in registry["records"] if row["level"] == "region"]
    region_data = regional_catalog(args.upstream, regions, upper)
    settlement_data = settlement_catalog(upper, lower)
    write_catalog(path / "regions.json.gz", region_data)
    write_catalog(path / "settlement-parents.json.gz", settlement_data)
    print(json.dumps({"regions": region_data["counts"], "settlements": settlement_data["counts"]}))


if __name__ == "__main__":
    main()
