"""Catálogos de zona y región: coincidencias exactas, sin repartir registros."""
import json
import re
import unicodedata
from collections import defaultdict


def key(value):
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", text.lower())


def codes(value):
    return re.findall(r"\b\d{4}\b", str(value or ""))


def read_geography(root):
    catalogs = {}
    for dimension in ("zonas", "regiones"):
        path = root / f"config/cecos_{dimension}.json"
        catalogs[dimension] = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else []
    zones, regions = catalogs["zonas"], catalogs["regiones"]
    by_zone_name, by_region_name = defaultdict(list), defaultdict(list)
    by_zone_code, by_region_code = defaultdict(list), defaultdict(list)
    for entries, names, identifiers in ((zones, by_zone_name, by_zone_code),
                                         (regions, by_region_name, by_region_code)):
        for entry in entries:
            names[key(entry["unidad_contrato"])].append(entry)
            for code in codes(entry["ceco"]):
                identifiers[code].append(entry)

    result = {}
    tokens = set(by_zone_name) | set(by_region_name) | set(by_zone_code) | set(by_region_code)
    for token in tokens:
        direct_zones, direct_regions = by_zone_name[token], by_region_name[token]
        zone_codes = {c for entry in direct_zones for c in codes(entry["ceco"])}
        region_codes = {c for entry in direct_regions for c in codes(entry["ceco"])}
        # An explicit code in the region table can distinguish the ASEO contract.
        identifiers = ({token} if re.fullmatch(r"\d{4}", token) else
                       zone_codes & region_codes or region_codes or zone_codes)
        matched_zones = [entry for code in identifiers for entry in by_zone_code[code]] or direct_zones
        matched_regions = direct_regions or [entry for code in identifiers for entry in by_region_code[code]]
        if not matched_regions:
            matched_regions = [region for entry in matched_zones
                               for region in by_region_name[key(entry["unidad_contrato"])]]
        zone_values = {f"Zona {entry['zona']}" for entry in matched_zones}
        region_values = {entry["region"] for entry in matched_regions}
        names = {entry["unidad_contrato"] for entry in matched_zones}
        if not names:
            names = {entry["unidad_contrato"] for entry in matched_regions}
        association = {"ceco": next(iter(identifiers)) if len(identifiers) == 1 else "",
                       "unidad": next(iter(names)) if len(names) == 1 else "",
                       "observaciones": []}
        for field, values in (("zona", zone_values), ("region", region_values)):
            if len(values) == 1:
                association[field] = next(iter(values))
            elif len(values) > 1:
                association["observaciones"].append(
                    f"{'Región' if field == 'region' else 'Zona'} ambigua en el catálogo: {' / '.join(sorted(values))}")
        result[token] = association

    notes = []
    for entries in by_region_name.values():
        values = {entry["region"] for entry in entries}
        if len(values) > 1:
            notes.append(f"{entries[0]['unidad_contrato']}: figura en {' y '.join(sorted(values))}; "
                         "requiere una asociación explícita para resolver la región.")
    for code, entries in sorted(by_region_code.items()):
        names = {entry["unidad_contrato"] for entry in entries}
        if len(names) > 1:
            notes.append(f"CeCo {code}: compartido por {' / '.join(sorted(names))}. "
                         "Se conserva la tabla recibida y el nombre de la fuente.")
    return {"asociaciones": result, "observaciones": notes}
