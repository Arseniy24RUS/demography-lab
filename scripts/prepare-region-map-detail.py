"""Dissolve the pinned RUDN municipal data into an optional detailed map."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from importlib.util import module_from_spec, spec_from_file_location
import json
from math import cos, radians
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import shapely
from shapely.affinity import scale
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import transform


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public/data"
FOCUS = {"moskva", "respublika-ingushetiia"}
MIN_OVERLAP = 0.8
SMALL_RING_AREA = 0.00002  # squared geographic degrees
MODULE = spec_from_file_location("territory_ingest", ROOT / "scripts/ingest-territories.py")
INGEST = module_from_spec(MODULE)
MODULE.loader.exec_module(INGEST)


def read_json(file: Path):
    return json.loads(file.read_bytes())


def polygon_parts(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [part for piece in geometry.geoms for part in polygon_parts(piece)]
    return []


def unwrap(geometry, origin):
    def longitude(value):
        return origin + ((value - origin + 180) % 360 - 180)

    def unwrap_point(x, y):
        if hasattr(x, "__iter__"):
            return [longitude(value) for value in x], y
        return longitude(x), y

    return transform(unwrap_point, shape(geometry))


def region_outline(features, origin):
    municipalities = [unwrap(feature["geometry"], origin) for feature in features]
    if not municipalities or any(not unit.is_valid or unit.is_empty for unit in municipalities):
        raise ValueError("Invalid source municipality geometry")
    return shapely.union_all(municipalities, grid_size=0.0000001)


def compact_outline(outline, tolerance, longitude_scale):
    # Discard isolated subpixel polygons and holes, including gaps between districts
    # whose shared borders were simplified separately by the original source.
    polygons = [
        Polygon(polygon.exterior, [ring for ring in polygon.interiors if Polygon(ring).area >= SMALL_RING_AREA])
        for polygon in polygon_parts(outline)
        if polygon.area >= SMALL_RING_AREA
    ]
    local_outline = scale(shapely.union_all(polygons), xfact=longitude_scale, origin=(0, 0))
    simplified = local_outline.simplify(tolerance, preserve_topology=True)
    return scale(simplified, xfact=1 / longitude_scale, origin=(0, 0))


def build(cache: Path, download: bool):
    locked = [
        record for record in read_json(ROOT / "scripts/territories-source-lock.json")["files"]
        if record["repository"] == "Arseniy24RUS/RUDN"
    ]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda record: INGEST.acquire(cache, record, download), locked))
    catalog = read_json(cache / "rudn/catalog.json")
    index = {entry["sourceRegionId"]: entry for entry in read_json(DATA / "territories/index.json")["regions"]}
    overview = {
        INGEST.normalize_region(feature["properties"]["name"]): feature["geometry"]
        for feature in read_json(DATA / "regions.geojson")["features"]
    }
    if len(overview) != len(index) or len(index) != len(catalog["subjects"]):
        raise ValueError("Map sources contain different regional scopes")

    features, omitted = [], []
    for entry in catalog["subjects"]:
        region = index[entry["id"]]
        region_id = region["regionId"]
        municipalities = read_json(cache / "rudn" / Path(entry["file"]).name)["features"]
        if len(municipalities) != entry["units"] or any(
            str(unit["properties"]["subject_id"]) != entry["id"] for unit in municipalities
        ):
            raise ValueError(f"Invalid source municipality collection: {region_id}")
        map_pack = read_json(DATA / region["mapPath"].removeprefix("/data/"))
        origin = map_pack["projection"]["longitudeOrigin"]
        boundary = region_outline(municipalities, origin)
        reference = unwrap(overview[INGEST.normalize_region(region["name"])], origin)
        if not reference.is_valid:
            reference = shapely.union_all(polygon_parts(shapely.make_valid(reference)))
        overlap = boundary.intersection(reference).area / boundary.union(reference).area
        if overlap < MIN_OVERLAP:
            omitted.append(region_id)
            continue
        small_region = region_id in FOCUS
        tolerance = 0.001 if small_region else 0.004
        longitude_scale = 1 if small_region else cos(radians(map_pack["projection"]["referenceLatitude"]))
        compact = compact_outline(boundary, tolerance, longitude_scale)
        if compact.is_empty or not compact.is_valid or abs(compact.area / boundary.area - 1) > 0.004:
            raise ValueError(f"Compaction changed the regional footprint: {region_id}")
        features.append({
            "type": "Feature",
            "properties": {"regionId": region_id, "name": region["name"], "smallRegion": small_region},
            "geometry": mapping(compact),
        })

    if not FOCUS.issubset(feature["properties"]["regionId"] for feature in features):
        raise ValueError("The detailed layer must include both small regions used for acceptance")
    repository = locked[0]["repository"]
    revision = locked[0]["commit"]
    input_digest = sha256("".join(record["sha256"] for record in locked).encode()).hexdigest()
    return {
        "source": {
            "sourceUrl": f"https://github.com/{repository}/tree/{revision}/site/assets/puzzle/data/municipal",
            "inputSha256": input_digest,
            "sourceArchiveDate": catalog["source_archive_date"],
            "licenseStatus": catalog["license"],
            "method": "Municipal polygons dissolved by subject; compatible with the overview Albers projection.",
            "overviewOnlyRegionIds": omitted,
        },
        "features": features,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache/territory-sources")
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    detail = build(args.cache, args.download)
    with TemporaryDirectory(prefix="regional-outline-") as temp:
        source = Path(temp) / "detail.json"
        source.write_text(json.dumps(detail, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        subprocess.run(["node", str(ROOT / "scripts/prepare-region-map.mjs"), "--detail-input", str(source)], check=True)


if __name__ == "__main__":
    main()
