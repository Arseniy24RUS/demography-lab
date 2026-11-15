"""Recreate browser inputs from the validated local Spectrum package and roadmap data."""
from argparse import ArgumentParser
import json
import math
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
REGION = "respublika-mordoviia"
COMPONENTS = {"births": "births_total", "deaths": "deaths_total",
              "arrivals": "mig_in_total", "departures": "mig_out_total"}
SEXES = {"male": "M", "female": "F"}
BASE_YEAR = 2024


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def as_number(value):
    if value is None or not math.isfinite(value):
        return None
    if value < 0:
        raise ValueError(f"Negative observed count: {value!r}")
    return int(value) if int(value) == value else float(value)


def historical_rows(pack, territory_key, stocks):
    source = next(item for item in pack["series"] if item["territoryKey"] == territory_key)
    columns = {name: pack["columns"].index(metric) for name, metric in COMPONENTS.items()}
    rows = {row[0]: row for row in source["rows"] if 2008 <= row[0] <= BASE_YEAR}
    return [
        {"year": year, "population": stocks.get(year),
         **{name: as_number(rows[year][position]) if year in rows else None
            for name, position in columns.items()}}
        for year in sorted(rows.keys() | stocks.keys())
    ]


def observed_stocks(raw):
    rows = raw[raw["indicator_code"].eq("Y48112014") & raw["sex"].eq("T") & raw["age_kind"].eq("total")
               & raw["status"].eq("observed") & raw["year"].le(BASE_YEAR)
               & raw["reference_date"].astype(str).eq(raw["year"].astype(str) + "-01-01")]
    if rows.duplicated(["municipality_code", "year"]).any():
        raise ValueError("Duplicate observed stock for the same municipality and year")
    return {code: {int(year): as_number(value) for year, value in zip(group["year"], group["value"])}
            for code, group in rows.groupby("municipality_code")}


def migration_profile(frame, codes, exterior_only=False):
    data = frame[frame["municipality_code"].isin(codes)]
    if exterior_only:
        data = data[data["category"].isin(["interregional", "international"])]
    result = {}
    for direction in ("arrivals", "departures"):
        relevant = data[data["direction"].eq(direction)]
        by_sex = {
            key: relevant[relevant["sex"].eq(sex)].groupby("age_lower")["value"].sum()
            .reindex(range(0, 81, 5), fill_value=0).tolist()
            for key, sex in SEXES.items()
        }
        total = sum(sum(weights) for weights in by_sex.values())
        if total <= 0 or any(weight < 0 for weights in by_sex.values() for weight in weights):
            raise ValueError(f"Invalid {direction} profile for {codes}")
        result[direction] = {key: [round(value / total, 10) for value in weights]
                             for key, weights in by_sex.items()}
    return result


def external_migration_totals(raw, codes, indicator):
    # Regional gross flows exclude movement between municipalities within Mordovia.
    # The total and domestic components are published even when some international
    # counts are suppressed, so subtract the observed within-region component.
    selected = raw[raw["municipality_code"].isin(codes) & raw["indicator_code"].eq(indicator)
                   & raw["sex"].eq("T") & raw["age_kind"].eq("total")
                   & raw["migration_category"].isin(["all", "within_region"])]
    totals = {}
    for year, rows in selected.groupby("year"):
        pairs = set(zip(rows["municipality_code"], rows["migration_category"]))
        if len(rows) == len(pairs) == 2 * len(codes):
            pivot = rows.pivot(index="municipality_code", columns="migration_category", values="value")
            external = pivot["all"] - pivot["within_region"]
            if external.notna().all() and external.ge(0).all():
                totals[int(year)] = as_number(external.sum())
    return totals


def projection_assumptions(model_dir, original):
    flows = pd.read_parquet(model_dir / "assumptions.parquet")
    control = pd.read_parquet(model_dir / "cohort_control.parquet")
    annual = flows.merge(control, on=["municipality_code", "year"], validate="one_to_one")
    annual["arrivals"] = annual["arrivalsM"] + annual["arrivalsF"]
    annual["departures"] = annual["departuresM"] + annual["departuresF"]
    annual["fertility_exposure"] = annual["births"] / annual["TFR"]
    for sex in SEXES.values():
        annual = annual.sort_values("year")
        start = annual.groupby("municipality_code")[f"population_end_{sex}"].shift(1)
        seed = {item["code"]: sum(item["base_single"][sex]) for item in original}
        annual[f"population_start_{sex}"] = start.fillna(annual["municipality_code"].map(seed))
        annual[f"weighted_e0{sex}"] = annual[f"e0{sex}"] * annual[f"population_start_{sex}"]

    categories = pd.read_parquet(model_dir / "migration_projection_categories.parquet")
    exterior = categories[categories["category"].isin(["interregional", "international"])]
    exterior = exterior.groupby("year")[["arrivals", "departures"]].sum()
    summed = annual.groupby("year")[["population_start", "births", "fertility_exposure",
        "population_start_M", "population_start_F", "weighted_e0M", "weighted_e0F"]].sum()
    summed = summed.join(exterior, how="left", validate="one_to_one")
    summed["TFR"] = summed["births"] / summed["fertility_exposure"]
    for sex in SEXES.values():
        summed[f"e0{sex}"] = summed[f"weighted_e0{sex}"] / summed[f"population_start_{sex}"]

    def rows(frame):
        years = list(frame.index)
        if years != list(range(BASE_YEAR, 2100)):
            raise ValueError(f"Unexpected modeled component years {years}")
        return [
            {"year": int(year), "fertilityRate": round(row.TFR, 8),
             "lifeExpectancy": {key: round(row[f"e0{sex}"], 5) for key, sex in SEXES.items()},
             "arrivalsPerPerson": round(row.arrivals / row.population_start, 10),
             "departuresPerPerson": round(row.departures / row.population_start, 10)}
            for year, row in frame.iterrows()
        ]

    annual = annual[annual["year"].lt(2100)]
    return {code: rows(group.set_index("year")) for code, group in annual.groupby("municipality_code")}, rows(summed.loc[:2099])


def input_source(reference, is_region):
    URLs = {source["component"]: source["url"] for source in reference["sources"]}
    notes = [
        "Численность на 1 января 2024 года. Расчёт по однолетним возрастам с открытой группой 80+. "
        "Разбивка внутри 70–79 лет оценена передвижкой региональных когорт.",
        "Возрастная рождаемость опирается на профиль Мордовии 2021 года. "
        "При рождении принято 105,7 мальчика на 100 девочек, по данным Spectrum для России.",
        "Возрастная смертность калибруется по местному числу умерших и прогнозу продолжительности "
        "жизни мужчин и женщин из учебного комплекта.",
        "Возрастные доли прибытия и выбытия оценены по наблюдаемым миграционным потокам.",
        "Базовый сценарий продолжает последние наблюдения каждого компонента по отдельности. "
        "Затем расчёт плавно переходит к возрастной рождаемости, выживаемости и относительным "
        "потокам миграции, оценённым в учебном комплекте.",
    ]
    if is_region:
        notes.append("Численность суммируется по 23 муниципалитетам. Миграция региона рассчитана "
                     "как разность общего и внутрирегионального потоков по всем муниципалитетам.")
    return {
        "summary": "Учебный комплект для Мордовии, БДМО Росстата и региональные профили",
        "baseDate": "2024-01-01",
        "citations": [
            {"label": "Муниципальная статистика России с 2005 года", "url": "https://doi.org/10.48612/tochno/bdmo"},
            {"label": "Демографическая программа Мордовии", "url": URLs["fertility"]},
            {"label": "Статистический ежегодник Росстата за 2024 год", "url": URLs["e0"]},
            {"label": "Методика Settlements Projection Dashboard",
             "url": "https://github.com/Arseniy24RUS/Settlements-projection-dashboard/blob/main/docs/methodology.md"},
        ],
        "notes": notes,
    }


def prepare(spectrum_dir):
    public = ROOT / "public/data/territories"
    catalog = read_json(public / "registry.json")["records"]
    by_code = {record["statistics"]["sourceCode"]: record for record in catalog
               if record["regionId"] == REGION and record["level"] == "municipality"
               and record["statistics"]["sourceCode"]}
    pack = read_json(public / "regions" / f"{REGION}.statistics.json")
    previous = read_json(spectrum_dir / "model/package_inputs.json")["municipalities"]
    reference = read_json(spectrum_dir / "supplementary/model_reference.json")
    profiles = pd.read_parquet(spectrum_dir / "model/migration_profile_reconstruction.parquet")
    raw = pd.read_parquet(spectrum_dir / "data/migration_age_sex.parquet")
    stocks = observed_stocks(pd.read_parquet(spectrum_dir / "data/stocks_age_sex.parquet"))
    municipal_assumptions, regional_assumptions = projection_assumptions(spectrum_dir / "model", previous)
    codes = [item["code"] for item in previous]
    if len(set(codes)) != len(codes) or len(codes) != 23 or set(codes) - set(by_code):
        raise ValueError("The confirmed scope must match the same 23 municipality codes.")

    def item(key, name, base, history, selected_codes, is_region=False):
        if any(len(ages) != 81 for ages in base.values()):
            raise ValueError(f"Unexpected age intervals for {key}")
        if next(row["population"] for row in history if row["year"] == BASE_YEAR) != sum(map(sum, base.values())):
            raise ValueError(f"Population by age does not reconcile with the observed total for {key}")
        if any(sum(row[name] is not None for row in history) < 5 for name in COMPONENTS):
            raise ValueError(f"Insufficient historical counts for {key}")
        return {
            "territoryKey": key,
            "name": name,
            "base": base,
            "baseYear": BASE_YEAR,
            "fertilityShares": reference["fertility_shares"],
            "sexRatioAtBirth": reference["sex_ratio_at_birth_males_per_100_females"],
            "history": history,
            "assumptions": regional_assumptions if is_region else municipal_assumptions[selected_codes[0]],
            "migrationProfile": migration_profile(profiles, selected_codes, is_region),
            "source": input_source(reference, is_region),
        }

    result = []
    for old in previous:
        key = by_code[old["code"]]["territoryKey"]
        result.append(item(key, by_code[old["code"]]["name"],
                           {key: old["base_single"][sex] for key, sex in SEXES.items()},
                           historical_rows(pack, key, stocks[old["code"]]), [old["code"]]))
    if sum(sum(ages) for muni in result for ages in muni["base"].values()) != 765891:
        raise ValueError("The base no longer reconciles with the validated Spectrum stock.")
    regional_arrivals = external_migration_totals(raw, codes, "Y48112021")
    regional_departures = external_migration_totals(raw, codes, "Y48112022")
    municipal_by_year = [{row["year"]: row for row in muni["history"]} for muni in result]
    official_regional_vitals = {row["year"]: row for row in reference["regional_vital_totals"]}

    def complete_total(year, component):
        values = [rows.get(year, {}).get(component) for rows in municipal_by_year]
        return sum(values) if all(value is not None for value in values) else None

    regional_history = [
        {"year": year, "population": complete_total(year, "population"),
         **{component: official_regional_vitals[year][component] if year in official_regional_vitals
            else complete_total(year, component) for component in ("births", "deaths")},
         "arrivals": regional_arrivals.get(year), "departures": regional_departures.get(year)}
        for year in sorted(set().union(*(rows.keys() for rows in municipal_by_year)))
    ]
    result.append(item(
        f"region:{REGION}", "Республика Мордовия",
        {sex: [sum(values) for values in zip(*(muni["base"][sex] for muni in result))] for sex in SEXES},
        regional_history, codes, True,
    ))
    return {"schemaVersion": 1, "territories": result}


def main():
    args = ArgumentParser(description=__doc__)
    args.add_argument("spectrum_dir", type=Path)
    options = args.parse_args()
    destination = ROOT / "public/data/cohort/mordovia.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(prepare(options.spectrum_dir), ensure_ascii=False,
                                      allow_nan=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
