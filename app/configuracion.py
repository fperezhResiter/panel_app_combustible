"""Selecciones persistentes e independientes para los modos zona y región."""
import json
import os
import re
import sqlite3
from contextlib import closing, contextmanager
from .asociaciones import key

MODES = ("zona", "region")


def default_configuration():
    return {"revision": 0, "modos": {mode: {"grupos": {}, "unidades": {}} for mode in MODES}}


def read_configuration(root):
    path = root / "Datos/combustible.sqlite"
    if not path.exists():
        return default_configuration()
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuracion'").fetchone():
            return default_configuration()
        row = db.execute("SELECT contenido FROM configuracion WHERE id=1").fetchone()
    return json.loads(row[0]) if row else default_configuration()


@contextmanager
def publication_lock(root):
    lock = root / "Datos/actualizacion.lock"
    lock.parent.mkdir(exist_ok=True, parents=True)
    try:
        handle = lock.open("x")
    except FileExistsError as exc:
        raise ValueError("Hay una actualización o un guardado en curso. Espera a que termine y vuelve a intentar.") from exc
    try:
        with handle:
            handle.write(str(os.getpid()))
        yield
    finally:
        lock.unlink(missing_ok=True)


def unit_id(group, unit):
    # El nombre distingue unidades que comparten código. El sufijo que agrega
    # el lector a las fuentes con código no cambia la identidad del contrato.
    name = re.sub(r"\s*\(\d{4}\)$", "", unit)
    return json.dumps([group, key(name)], ensure_ascii=False, separators=(",", ":"))


def visible(record, mode, configuration):
    selection = configuration["modos"][mode]
    group = record.get(mode) or ("SIN ZONA" if mode == "zona" else "Sin región")
    return (selection["grupos"].get(group, True)
            and selection["unidades"].get(unit_id(group, record["unidad"]), True))


def configuration_catalog(root, records, associations):
    result = {}
    for mode, filename in (("zona", "zonas"), ("region", "regiones")):
        groups = {}

        def add(group, unit, code="", count=0):
            identifier = unit_id(group, unit)
            units = groups.setdefault(group, {})
            item = units.setdefault(identifier, {"id": identifier, "nombre": unit,
                                                 "ceco": code, "registros": 0})
            item["registros"] += count
            if count:
                item["nombre"], item["ceco"] = unit, code

        path = root / f"config/cecos_{filename}.json"
        entries = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else []
        for entry in entries:
            unit = entry["unidad_contrato"]
            override = associations.get(key(unit), {}).get("csv_override", {})
            code_override = associations.get(key(entry["ceco"]), {}).get("csv_override", {})
            group = (override.get(mode) or code_override.get(mode)
                     or (f"Zona {entry['zona']}" if mode == "zona" else entry["region"]))
            add(group, unit, "" if entry["ceco"] == "Sin código" else entry["ceco"])
        for record in records:
            group = record.get(mode) or ("SIN ZONA" if mode == "zona" else "Sin región")
            add(group, record["unidad"], record.get("ceco", ""), 1)
        result[mode] = [{"id": group, "nombre": group,
                         "unidades": sorted(units.values(), key=lambda u: key(u["nombre"]))}
                        for group, units in sorted(groups.items(), key=lambda item: key(item[0]))]
    return result


def configuration_state(root, publication, associations):
    configuration = read_configuration(root)
    applied = publication.get("configuracion_aplicada", default_configuration())
    catalog = configuration_catalog(root, publication["registros"], associations)
    for mode, groups in catalog.items():
        selection = configuration["modos"][mode]
        for group in groups:
            group["mostrar"] = selection["grupos"].get(group["id"], True)
            for unit in group["unidades"]:
                unit["mostrar"] = selection["unidades"].get(unit["id"], True)
    return {"revision": configuration["revision"], "catalogo": catalog,
            "pendiente": configuration["modos"] != applied["modos"],
            "publicada_revision": applied["revision"]}


def save_configuration(root, change, publication, associations):
    if not isinstance(change, dict):
        raise ValueError("La selección debe ser un objeto JSON.")
    mode, kind, identifier = (change.get(field) for field in ("modo", "tipo", "id"))
    if (mode not in MODES or kind not in ("grupos", "unidades")
            or not isinstance(identifier, str) or type(change.get("mostrar")) is not bool
            or type(change.get("revision")) is not int):
        raise ValueError("La selección de configuración no es válida.")
    catalog = configuration_catalog(root, publication["registros"], associations)
    valid = {group["id"] for group in catalog[mode]} if kind == "grupos" else {
        unit["id"] for group in catalog[mode] for unit in group["unidades"]}
    if identifier not in valid:
        raise ValueError("La zona, región o unidad ya no pertenece al catálogo. Recarga la configuración.")
    with publication_lock(root):
        configuration = read_configuration(root)
        if change["revision"] != configuration["revision"]:
            raise ValueError("La configuración cambió en otra ventana. Recárgala antes de guardar de nuevo.")
        # Guardar solo exclusiones: volver a marcar restaura el valor inicial.
        selection = configuration["modos"][mode][kind]
        if change["mostrar"]:
            selection.pop(identifier, None)
        else:
            selection[identifier] = False
        configuration["revision"] += 1
        with closing(sqlite3.connect(root / "Datos/combustible.sqlite")) as db:
            with db:
                db.execute("CREATE TABLE IF NOT EXISTS configuracion (id INTEGER PRIMARY KEY CHECK (id=1), contenido TEXT NOT NULL)")
                db.execute("INSERT OR REPLACE INTO configuracion VALUES (1, ?)",
                           (json.dumps(configuration, ensure_ascii=False),))
    return configuration_state(root, publication, associations)
