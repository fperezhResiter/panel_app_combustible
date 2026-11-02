"""Catálogo de equipos por patente, leído sin modificar el libro compartido."""
import hashlib
import json
import re
import warnings
from collections import defaultdict
from datetime import datetime, timezone

from .asociaciones import key


DEFAULT_PATH = "../../../06. Mantenimiento/03 MAESTRO EQUIPOS MOVILES/Maestro_Equipos_Moviles.xlsx"
DEFAULT_SHEET = "01 MAESTRO"
HEADERS = {"patente": "PATENTE", "zona": "ZONA", "linea": "LINEA DE NEGOCIO",
           "ceco": "CECO ACTIVO FIJO", "tipo_equipo": "TIPO DECLARADO"}
OPTIONAL_HEADERS = {"unidad": "FAENA ACTIVO FIJO"}


def cell_text(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    return "" if key(text) in {"", "sindato", "noaplica", "na"} else text


def plate_key(value):
    token = key(cell_text(value))
    return "" if token in {"sinpatente", "sinplaca", "0"} else token.upper()


def zone_label(value):
    text = cell_text(value)
    match = re.fullmatch(r"(?:ZONA\s*|Z\s*)(\d+)(?:\s+.*)?", text, re.I)
    return f"Zona {int(match[1])}" if match else text


def parse_master_rows(rows):
    columns = None
    grouped = defaultdict(list)
    read_count = without_plate = 0
    for row_number, values in enumerate(rows, 1):
        if columns is None:
            normalized = [key(value) for value in values]
            if all(key(label) in normalized for label in HEADERS.values()):
                columns = {}
                for field, label in dict(HEADERS, **OPTIONAL_HEADERS).items():
                    positions = [index for index, value in enumerate(normalized) if value == key(label)]
                    if len(positions) > 1:
                        raise ValueError(f"Columna duplicada en el maestro: {label}")
                    if positions:
                        columns[field] = positions[0]
            elif row_number >= 30:
                break
            continue
        row = {field: cell_text(values[index] if index < len(values) else None)
               for field, index in columns.items()}
        if all(key(row.get(field)) == key(label) for field, label in HEADERS.items()):
            continue
        if not any(row.values()):
            continue
        read_count += 1
        token = plate_key(row["patente"])
        if not token:
            without_plate += 1
            continue
        row["zona"] = zone_label(row["zona"])
        row["ceco"] = re.sub(r"^(\d{4})\.0+$", r"\1", row["ceco"])
        row["fila"] = row_number
        grouped[token].append(row)
    if columns is None:
        raise ValueError("El maestro no contiene las columnas " + ", ".join(HEADERS.values()))
    if not grouped:
        raise ValueError("La hoja del maestro no contiene equipos con patente")

    equipment = {}
    for token, entries in grouped.items():
        first = entries[0]
        item = {"patente": first["patente"], "fila_tipo": first["fila"],
                "filas": [entry["fila"] for entry in entries], "variantes": {}, "observaciones": []}
        for field, label in dict(HEADERS, **OPTIONAL_HEADERS).items():
            if field == "patente":
                continue
            unique = {}
            for entry in entries:
                value = entry.get(field, "")
                if value:
                    unique.setdefault(key(value), value)
            variants = list(unique.values())
            item["variantes"][field] = variants
            if field == "tipo_equipo":
                # User rule: the first physical row owns TIPO DECLARADO.
                item[field] = first[field]
            elif len(variants) > 1:
                item[field] = ""
                item["observaciones"].append(f"{label} ambiguo en maestro de equipos: {' / '.join(variants)}")
            else:
                item[field] = variants[0] if variants else ""
        equipment[token] = item
    return equipment, {"filas": read_count, "sin_patente": without_plate,
                       "patentes": len(equipment),
                       "patentes_repetidas": sum(len(item["filas"]) > 1 for item in equipment.values()),
                       "tipos_multiples": sum(len(item["variantes"]["tipo_equipo"]) > 1
                                              for item in equipment.values())}


def read_equipment_master(root):
    settings_path = root / "config/maestro_equipos.json"
    settings = json.loads(settings_path.read_text(encoding="utf-8-sig")) if settings_path.exists() else {}
    relative_path, sheet_name = settings.get("ruta", DEFAULT_PATH), settings.get("hoja", DEFAULT_SHEET)
    if not isinstance(relative_path, str) or not relative_path.strip() or not isinstance(sheet_name, str) or not sheet_name.strip():
        raise ValueError("La ruta y la hoja de config/maestro_equipos.json deben ser textos no vacíos")
    path = (root / relative_path).resolve()
    try:
        from openpyxl import load_workbook
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        book = load_workbook(path, read_only=True, data_only=True)
        try:
            if sheet_name not in book.sheetnames:
                raise ValueError(f"No existe la hoja {sheet_name}")
            # Validation extensions are irrelevant to this read-only data import.
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="Data Validation extension is not supported and will be removed",
                                        category=UserWarning, module=r"openpyxl\..*")
                equipment, stats = parse_master_rows(book[sheet_name].iter_rows(values_only=True))
        finally:
            book.close()
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("El libro cambió durante la lectura. Vuelve a actualizar")
    except Exception as exc:
        raise ValueError(f"No se pudo leer el maestro {path.name}, hoja {sheet_name}: {exc}. "
                         "Se conserva la publicación anterior.") from exc
    for item in equipment.values():
        item["origen"] = f"{path.name} / {sheet_name} · filas {', '.join(map(str, item['filas']))}"
    return {"equipos": equipment,
            "meta": dict(stats, archivo=path.name, ruta=relative_path, hoja=sheet_name,
                         sha256=digest, regla_tipo=f"Primera fila de cada patente en {sheet_name}",
                         modificado=datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat())}
