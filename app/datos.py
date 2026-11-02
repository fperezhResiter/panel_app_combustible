"""Lectura de fuentes, validación y publicación sin alterar los libros."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from .asociaciones import key, read_geography
from .configuracion import publication_lock, read_configuration, visible
from .maestro import plate_key, read_equipment_master

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = ["Fecha", "Hora", "Placa", "Marca", "Tipo unidad", "Conductor", "División", "CECO",
           "KM Odómetro", "KM Recorridos", "Galones", "Rendim. (km/gal)", "Tipo abast.",
           "Grifo/Estación", "Proveedor", "Precio/gal (S/.)", "Total S/.", "Precio validado",
           "Préstamo", "CECO préstamo", "Fotos", "GPS", "Estado", "Fuente"]
FIELDS = ["fecha", "hora", "placa", "marca", "tipo_unidad", "conductor", "division", "unidad",
          "odometro", "km", "galones", "rendimiento_reportado", "tipo_abast", "estacion",
          "proveedor", "precio", "total", "precio_validado", "prestamo", "unidad_prestamo",
          "fotos", "gps", "estado", "fuente"]
NUMBERS = {"odometro", "km", "galones", "rendimiento_reportado", "precio", "total"}
EXTRAS = {"zona": "Zona", "region": "Región", "linea": "Línea de negocio", "tipo_equipo": "Tipo de equipo"}


ALIASES = {key(label): field for label, field in zip(COLUMNS, FIELDS)}
ALIASES.update({key(label): field for field, label in EXTRAS.items()})
for field, names in {
    "placa": ["Patente", "Matrícula"], "unidad": ["Unidad", "Unidad / contrato", "Centro de costo", "Centro de costos"],
    "odometro": ["Odómetro", "Kilometraje"], "km": ["Kilómetros recorridos", "Km recorrido"],
    "tipo_abast": ["Tipo abastecimiento", "Tipo abast", "Tipo de abastecimiento"],
    "rendimiento_reportado": ["Rendimiento km/gal", "Rendimiento (km/gal)", "Rendim km gal"],
    "precio": ["Precio/gal", "Precio galón"], "total": ["Total S/", "Total S/.", "Total"],
    "tipo_unidad": ["Tipo de unidad"], "linea": ["Línea negocio"],
    "ceco": ["Código CeCo", "Código centro de costo"]
}.items():
    ALIASES.update({key(name): field for name in names})


def plain(value):
    if value is None:
        return ""
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    return str(value).strip()


def number(value):
    if value is None or plain(value) in {"", "—", "-"}:
        return None
    if isinstance(value, bool):
        raise ValueError("no es un número")
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        text = re.sub(r"\s|\u00a0|S/\.?", "", plain(value), flags=re.I)
        if "," in text and "." in text:
            decimal = "," if text.rfind(",") > text.rfind(".") else "."
            text = text.replace("." if decimal == "," else ",", "").replace(decimal, ".")
        elif text.count(".") > 1 or text.count(",") > 1:
            separator = "." if "." in text else ","
            if not re.fullmatch(r"[+-]?\d{1,3}(" + re.escape(separator) + r"\d{3})+", text):
                raise ValueError("separadores inválidos")
            text = text.replace(separator, "")
        else:
            text = text.replace(",", ".")
        result = float(text)
    if not math.isfinite(result):
        raise ValueError("número no finito")
    return result


def parse_date(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (int, float)) and 1 < value < 100000:
        return (datetime(1899, 12, 30) + timedelta(days=value)).date().isoformat()
    text = plain(value)
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%d/%m/%y"):
        try:
            return datetime.strptime(text.split("T")[0].split(" ")[0], fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError("fecha inválida")


def parse_time(value):
    if isinstance(value, datetime):
        return value.strftime("%H:%M:%S")
    if isinstance(value, time):
        return value.strftime("%H:%M:%S")
    if isinstance(value, (int, float)) and 0 <= value < 1:
        seconds = round(value * 86400) % 86400
        return f"{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02}"
    if not plain(value):
        return ""
    try:
        return time.fromisoformat(plain(value)).strftime("%H:%M:%S")
    except ValueError as exc:
        raise ValueError("hora inválida") from exc


def read_catalog(root, geography=None):
    result = (geography if geography is not None else read_geography(root))["asociaciones"].copy()
    path = root / "config/unidades.csv"
    if not path.exists():
        return result
    seen = set()
    with path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source, delimiter=";"):
            row = {ALIASES.get(key(k), k): plain(v) for k, v in row.items()}
            unit = key(row.get("unidad"))
            if not unit:
                continue
            if unit in seen:
                raise ValueError(f"Unidad duplicada en config/unidades.csv: {row['unidad']}")
            seen.add(unit)
            overrides = {k: v for k, v in row.items() if k in EXTRAS and v}
            result[unit] = dict(result.get(unit, {}), **overrides, csv_override=overrides)
    return result


def normalize(source, origin, catalog=None, equipment_catalog=None):
    raw = {ALIASES.get(key(k), str(k)): v for k, v in source.items() if k is not None}
    source_by_key = {key(k): v for k, v in source.items() if k is not None}
    explicit_unit = source_by_key.get("unidad") or source_by_key.get("unidadcontrato")
    if explicit_unit:
        raw["unidad"] = explicit_unit
    record = {field: plain(raw.get(field)) for field in FIELDS}
    record["original"] = {label: plain(source_by_key.get(key(label), raw.get(field)))
                          for label, field in zip(COLUMNS, FIELDS)}
    issues = []
    try:
        record["fecha"] = parse_date(raw.get("fecha"))
    except ValueError:
        record["fecha"] = None
        issues.append("Fecha ausente o inválida")
    try:
        record["hora"] = parse_time(raw.get("hora"))
    except ValueError:
        record["hora"] = ""
        issues.append("Hora inválida")
    for field in NUMBERS:
        try:
            record[field] = number(raw.get(field))
            if record[field] is not None and record[field] < 0:
                issues.append(f"{COLUMNS[FIELDS.index(field)]}: valor negativo")
        except (ValueError, TypeError, OverflowError):
            record[field] = None
            issues.append(f"{COLUMNS[FIELDS.index(field)]}: valor inválido")
    record["placa"] = record["placa"].upper().strip()
    if not record["placa"]:
        issues.append("Placa ausente")
    equipment = (equipment_catalog or {}).get(plate_key(record["placa"]), {})
    record["maestro_equipo"] = equipment or None
    if equipment_catalog is not None and record["placa"] and not equipment:
        issues.append("Patente sin asociación en maestro de equipos")
    issues.extend(equipment.get("observaciones", []))
    record["unidad"] = record["unidad"] or "SIN UNIDAD"
    record["estado"] = record["estado"] or "Sin estado"
    record["tipo_unidad"] = record["tipo_unidad"] or "Sin tipo de unidad"
    # CECO can contain a name or a numeric identifier; preserve the original columns.
    source_code = plain(raw.get("ceco"))
    for label, value in source.items():
        if key(label) == "ceco" and re.fullmatch(r"\d{4}(?:\.0)?", plain(value)):
            source_code = plain(value).removesuffix(".0")
    if not source_code and re.fullmatch(r"\d{4}(?:\.0)?", record["unidad"]):
        source_code = record["unidad"].removesuffix(".0")
    if re.fullmatch(r"\d{4}\.0", source_code):
        source_code = source_code.removesuffix(".0")
    # Attribute only this transaction to the borrowing unit, preserving source columns.
    record["unidad_origen"] = record["unidad"]
    record["atribucion_prestamo"] = key(record["prestamo"]) == "si"
    record["atribucion_maestro"] = bool(equipment.get("ceco")) and not record["atribucion_prestamo"]
    if record["atribucion_prestamo"]:
        destination = record["unidad_prestamo"]
        record["unidad"] = destination or "SIN UNIDAD"
        source_code = (destination.removesuffix(".0")
                       if re.fullmatch(r"\d{4}(?:\.0)?", destination) else "")
        if not destination:
            issues.append("Préstamo marcado Sí sin CECO préstamo; revisar unidad de atribución")
    elif record["atribucion_maestro"]:
        source_code = equipment["ceco"]
        record["unidad"] = equipment.get("unidad") or source_code
    association = (catalog or {}).get(key(source_code or record["unidad"]), {})
    code_override = (catalog or {}).get(key(source_code or association.get("ceco")), {}).get("csv_override", {})
    name_override = (catalog or {}).get(key(record["unidad"]), {}).get("csv_override", {})
    association = dict(association, **dict(code_override, **name_override))
    record["ceco"] = source_code or association.get("ceco", "")
    if re.fullmatch(r"\d{4}(?:\.0)?", record["unidad"]) and association.get("unidad"):
        record["unidad"] = f"{association['unidad']} ({record['ceco']})"
    # Explicit source geography cannot override a borrower or the fixed-asset master.
    unit_fields = {} if record["atribucion_prestamo"] or record["atribucion_maestro"] else raw
    master_zone = "" if record["atribucion_prestamo"] else equipment.get("zona", "")
    master_region = ((catalog or {}).get(key(equipment.get("unidad")), {}).get("region", "")
                     if record["atribucion_maestro"] else "")
    record["zona"] = master_zone or plain(unit_fields.get("zona")) or association.get("zona") or "SIN ZONA"
    record["region"] = plain(unit_fields.get("region")) or association.get("region") or master_region or "Sin región"
    for observation in association.get("observaciones", []):
        dimension = "region" if observation.startswith("Región") else "zona"
        if not (master_zone if dimension == "zona" else master_region) and not plain(unit_fields.get(dimension)) and not association.get(dimension):
            issues.append(observation)
    master_line = equipment.get("linea", "")
    if record["atribucion_prestamo"]:
        master_line = association.get("linea") or master_line
    record["linea"] = (master_line or plain(unit_fields.get("linea")) or association.get("linea")
                       or "Sin línea")
    record["tipo_equipo"] = (equipment.get("tipo_equipo") or plain(raw.get("tipo_equipo")) or association.get("tipo_equipo")
                            or "Sin tipo de equipo")
    if record["galones"] is None or record["galones"] <= 0:
        issues.append("Galones ausentes o no positivos")
    record["rendimiento"] = (record["km"] / record["galones"]
                              if record["km"] is not None and record["km"] >= 0
                              and record["galones"] is not None and record["galones"] > 0 else None)
    if record["rendimiento"] is not None and record["rendimiento_reportado"] is not None:
        if abs(record["rendimiento"] - record["rendimiento_reportado"]) > 0.011:
            issues.append("Rendimiento reportado difiere de KM / galones (más de 0,011)")
    record["origenes"] = [origin]
    record["alertas"] = issues
    signature = {field: record[field] for field in FIELDS}
    signature.update({field: record[field] for field in EXTRAS})
    signature["ceco"] = record["ceco"]
    # Invalid raw values must not collapse distinct source rows into the same null.
    signature["original"] = record["original"]
    record["id"] = hashlib.sha256(json.dumps(signature, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]
    return record


def sheet_records(rows, origin):
    headers = None
    for row_number, row in enumerate(rows, 1):
        row = list(row)
        if headers is None:
            fields = [ALIASES.get(key(v)) for v in row]
            if {"fecha", "placa", "galones"}.issubset(fields):
                nonempty = [f for f in fields if f]
                if len(set(nonempty)) != len(nonempty):
                    raise ValueError(f"{origin}: columnas duplicadas en encabezado")
                headers = fields
            elif row_number >= 30:
                return
            continue
        if not any(plain(v) for v in row):
            continue
        # Repeated headers inside exports are not transactions.
        if all(ALIASES.get(key(v)) == f for v, f in zip(row, headers) if f):
            continue
        values = {f: row[i] if i < len(row) else None for i, f in enumerate(headers) if f}
        if not any(plain(values.get(f)) for f in ("fecha", "placa", "galones")):
            continue
        yield values, f"{origin} · fila {row_number}", set(headers) - {None}


SPREADSHEET_NS = "{urn:schemas-microsoft-com:office:spreadsheet}"


def xml_sheet_rows(table):
    """Read Excel XML 2003, preserving sparse indexes and source row numbers."""
    next_row = 1
    for row in table.findall(SPREADSHEET_NS + "Row"):
        row_index = int(row.get(SPREADSHEET_NS + "Index", next_row))
        if not next_row <= row_index <= 1048576:
            raise ValueError("Índice de fila XML inválido")
        while next_row < row_index:
            yield []
            next_row += 1
        next_row += 1
        cells = row.findall(SPREADSHEET_NS + "Cell")
        # Full-width titles and copyright footers are not transactions.
        if len(cells) == 1 and int(cells[0].get(SPREADSHEET_NS + "MergeAcross", 0)) > 0:
            yield []
            continue
        values = []
        for cell in cells:
            index = int(cell.get(SPREADSHEET_NS + "Index", len(values) + 1))
            merged = int(cell.get(SPREADSHEET_NS + "MergeAcross", 0))
            if not len(values) < index <= 16384 or not 0 <= merged <= 16384 - index:
                raise ValueError("Índice de columna XML inválido")
            values.extend([None] * (index - len(values) - 1))
            element = cell.find(SPREADSHEET_NS + "Data")
            value = None
            if element is not None:
                text = "".join(element.itertext())
                value = text
                kind = element.get(SPREADSHEET_NS + "Type", "String")
                try:
                    if kind == "Number" and text.strip():
                        numeric = number(text)
                        value = int(numeric) if numeric.is_integer() else numeric
                    elif kind == "DateTime" and text.strip():
                        value = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
                    elif kind == "Boolean":
                        value = text.strip() == "1"
                except (ValueError, TypeError, AttributeError):
                    # Keep invalid source text for the existing quality checks.
                    value = text
            values.append(value)
            values.extend([None] * merged)
        yield values


def xls_records(path, relative):
    with path.open("rb") as source:
        signature = source.read(8)
    if signature == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" or signature[:2] in {b"\x09\x00", b"\x09\x02", b"\x09\x04", b"\x09\x08"}:
        try:
            import xlrd
        except ImportError as exc:
            raise RuntimeError("Este .xls binario requiere xlrd. Ejecuta Iniciar_Primera_Vez.bat.") from exc
        book = xlrd.open_workbook(str(path), on_demand=True)
        try:
            def rows(sheet):
                for row_index in range(sheet.nrows):
                    values = []
                    for cell in sheet.row(row_index):
                        value = cell.value
                        if cell.ctype in {xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK}:
                            value = None
                        elif cell.ctype == xlrd.XL_CELL_DATE:
                            value = xlrd.xldate_as_datetime(value, book.datemode)
                            if 0 <= cell.value < 1:
                                value = value.time()
                        elif cell.ctype == xlrd.XL_CELL_ERROR:
                            value = xlrd.error_text_from_code.get(value, str(value))
                        elif cell.ctype == xlrd.XL_CELL_NUMBER and value.is_integer():
                            value = int(value)
                        values.append(value)
                    yield values
            for sheet in book.sheets():
                yield from sheet_records(rows(sheet), f"{relative} / {sheet.name}")
        finally:
            book.release_resources()
        return
    try:
        workbook = ET.parse(path).getroot()
    except ET.ParseError as exc:
        raise ValueError("El .xls no tiene un formato binario o XML de Excel reconocido") from exc
    if workbook.tag != SPREADSHEET_NS + "Workbook":
        raise ValueError("El .xls no contiene un libro XML de Excel")
    for sheet in workbook.findall(SPREADSHEET_NS + "Worksheet"):
        table = sheet.find(SPREADSHEET_NS + "Table")
        if table is not None:
            name = sheet.get(SPREADSHEET_NS + "Name", "Hoja")
            yield from sheet_records(xml_sheet_rows(table), f"{relative} / {name}")


def file_records(path, root):
    relative = path.relative_to(root / "Fuentes").as_posix()
    if path.suffix.lower() == ".csv":
        content = path.read_bytes()
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("cp1252")
        try:
            dialect = csv.Sniffer().sniff(text[:8192], delimiters=";,\t|")
        except csv.Error:
            dialect = csv.excel
            dialect.delimiter = ";" if ";" in text.splitlines()[0] else ","
        yield from sheet_records(csv.reader(io.StringIO(text), dialect), relative)
    elif path.suffix.lower() == ".xls":
        yield from xls_records(path, relative)
    else:
        try:
            from openpyxl import load_workbook
        except ImportError as exc:
            raise RuntimeError("Falta openpyxl. Ejecuta Iniciar_Primera_Vez.bat.") from exc
        book = load_workbook(path, read_only=True, data_only=True)
        try:
            for sheet in book.worksheets:
                yield from sheet_records(sheet.iter_rows(values_only=True), f"{relative} / {sheet.title}")
        finally:
            book.close()


def build_payload(root=ROOT, sample=False):
    geography = read_geography(root)
    catalog = read_catalog(root, geography)
    master = read_equipment_master(root) if not sample else {"equipos": {}, "meta": {}}
    records = {}
    files = []
    duplicates = 0
    if sample:
        sources = [(row, "Muestra del mensaje inicial", set(FIELDS))
                   for row in json.loads((root / "app/muestra.json").read_text(encoding="utf-8"))]
        files = [{"archivo": "4 registros del mensaje inicial", "filas": 4, "faltantes": []}]
    else:
        paths = sorted(p for p in (root / "Fuentes").rglob("*")
                       if p.is_file() and not p.name.startswith("~$") and p.suffix.lower() in {".xls", ".xlsx", ".xlsm", ".csv"})
        if not paths:
            raise ValueError("No hay archivos .xls, .xlsx, .xlsm o .csv en Fuentes. Se conserva la publicación anterior.")
        sources = []
        for path in paths:
            try:
                loaded = list(file_records(path, root))
            except Exception as exc:
                raise ValueError(f"No se pudo leer {path.name}: {exc}. Se conserva la publicación anterior.") from exc
            if not loaded:
                raise ValueError(f"{path.name}: sin registros con Fecha, Placa y Galones. Se conserva la publicación anterior.")
            all_fields = set().union(*(fields for _, _, fields in loaded))
            files.append({"archivo": path.relative_to(root / "Fuentes").as_posix(), "filas": len(loaded),
                          "faltantes": [label for label, field in zip(COLUMNS, FIELDS) if field not in all_fields]})
            sources.extend(loaded)
    for row, origin, _ in sources:
        record = normalize(row, origin, catalog, master["equipos"] if not sample else None)
        if record["id"] in records:
            duplicates += 1
            records[record["id"]]["origenes"].append(origin)
        else:
            records[record["id"]] = record
    rows = list(records.values())
    identities = defaultdict(list)
    for row in rows:
        if row["fecha"] and row["hora"] and row["placa"]:
            identities[(row["fecha"], row["hora"], row["placa"])].append(row)
    for group in identities.values():
        if len(group) > 1:
            for row in group:
                row["alertas"].append("Fecha, hora y placa repetidas con valores distintos; revisar fuentes")
    rows.sort(key=lambda r: (r["fecha"] or "", r["hora"], r["placa"]), reverse=True)
    dates = [r["fecha"] for r in rows if r["fecha"]]
    configuration = read_configuration(root)
    master["meta"].update(registros_asociados=sum(bool(r["maestro_equipo"]) for r in rows),
                          registros_sin_asociacion=sum(not r["maestro_equipo"] for r in rows),
                          patentes_sin_asociacion=len({r["placa"] for r in rows if not r["maestro_equipo"]}))
    return {"schema": 4, "muestra": sample, "publicado": datetime.now(timezone.utc).isoformat(),
            "desde": min(dates) if dates else None, "hasta": max(dates) if dates else None,
            "columnas": COLUMNS, "campos": FIELDS, "archivos": files, "duplicados": duplicates,
            "registros": rows, "catalogo_observaciones": geography["observaciones"],
            "maestro_equipos": master,
            "alertas": dict(Counter(a for r in rows for a in r["alertas"])),
            "configuracion_aplicada": configuration,
            "visibilidad": {mode: [r["id"] for r in rows if visible(r, mode, configuration)]
                            for mode in ("zona", "region")}}


def publish(payload, root=ROOT):
    """Stage both artifacts first, retain prior publication if a replacement fails."""
    data_dir = root / "Datos"
    public_dir = root / "web/publicado"
    data_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)
    target_js = public_dir / "combustible.js"
    target_db = data_dir / "combustible.sqlite"
    temp_js = public_dir / "combustible.js.tmp"
    temp_db = data_dir / "combustible.sqlite.tmp"
    previous_js = target_js.read_bytes() if target_js.exists() else None
    js_replaced = False
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        temp_js.write_text("window.COMBUSTIBLE_DATA = " + encoded.replace("</", "<\\/") + ";\n", encoding="utf-8")
        if temp_db.exists():
            temp_db.unlink()
        db = sqlite3.connect(temp_db)
        try:
            db.execute("CREATE TABLE configuracion (id INTEGER PRIMARY KEY CHECK (id=1), contenido TEXT NOT NULL)")
            db.execute("INSERT INTO configuracion VALUES (1, ?)",
                       (json.dumps(read_configuration(root), ensure_ascii=False),))
            db.execute("CREATE TABLE publicacion (id INTEGER PRIMARY KEY, contenido TEXT NOT NULL)")
            db.execute("INSERT INTO publicacion VALUES (1, ?)", (encoded,))
            db.execute("CREATE TABLE registros (id TEXT PRIMARY KEY, fecha TEXT, placa TEXT, unidad TEXT, contenido TEXT)")
            db.executemany("INSERT INTO registros VALUES (?, ?, ?, ?, ?)", [
                (r["id"], r["fecha"], r["placa"], r["unidad"], json.dumps(r, ensure_ascii=False))
                for r in payload["registros"]])
            db.execute("CREATE TABLE maestro_equipos (patente TEXT PRIMARY KEY, zona TEXT, linea TEXT, ceco TEXT, tipo_equipo TEXT, contenido TEXT NOT NULL)")
            db.executemany("INSERT INTO maestro_equipos VALUES (?, ?, ?, ?, ?, ?)", [
                (token, item["zona"], item["linea"], item["ceco"], item["tipo_equipo"], json.dumps(item, ensure_ascii=False))
                for token, item in payload.get("maestro_equipos", {}).get("equipos", {}).items()])
            db.commit()
        finally:
            db.close()
        os.replace(temp_js, target_js)
        js_replaced = True
        os.replace(temp_db, target_db)
    except Exception:
        if js_replaced:
            if previous_js is None:
                target_js.unlink(missing_ok=True)
            else:
                temp_js.write_bytes(previous_js)
                os.replace(temp_js, target_js)
        raise
    finally:
        temp_js.unlink(missing_ok=True)
        temp_db.unlink(missing_ok=True)


def update(root=ROOT, sample=False):
    with publication_lock(root):
        payload = build_payload(root, sample)
        publish(payload, root)
        return payload


def read_publication(root=ROOT):
    # Static consultation and the API always read the same publication artifact.
    path = root / "web/publicado/combustible.js"
    content = path.read_text(encoding="utf-8")
    return json.loads(content.split("=", 1)[1].strip().removesuffix(";"))
