"""Asociación del maestro, precedencia de préstamos y persistencia del catálogo."""
import csv
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing, contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

from app.datos import build_payload, normalize, publish, read_publication, update
from app.maestro import parse_master_rows, plate_key, read_equipment_master


HEADERS = ["PATENTE", "ZONA", "LINEA DE NEGOCIO", "CECO ACTIVO FIJO", "TIPO DECLARADO", "FAENA ACTIVO FIJO"]
FIRST = ["TEST01", "ZONA 2 RESITER", "LÍNEA DEL EQUIPO", 2000, "CAMIÓN", "UNIDAD FIJA"]
SECOND = ["TEST-01", "ZONA 2 RESITER", "LÍNEA DEL EQUIPO", 2000, "GRÚA", "UNIDAD FIJA"]
CATALOG = {"unidadorigen": {"unidad": "UNIDAD ORIGEN", "ceco": "1000", "zona": "Zona 1", "region": "Región origen"},
           "2000": {"unidad": "UNIDAD FIJA", "ceco": "2000", "zona": "Zona 2", "region": "Región fija"},
           "unidaddestino": {"unidad": "UNIDAD DESTINO", "ceco": "3000", "zona": "Zona 3", "region": "Región destino"}}


def transaction(**changes):
    row = {"Fecha": "2026-10-01", "Hora": "10:00:00", "Placa": "TEST-01",
           "CECO": "UNIDAD ORIGEN", "Galones": 50, "KM Recorridos": 100,
           "Préstamo": "No", "CECO préstamo": "UNIDAD DESTINO"}
    row.update(changes)
    return row


@contextmanager
def temporary_project():
    workspace = Path(__file__).resolve().parents[1]
    temporary_root = workspace / "tmp"
    temporary_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="maestro-", dir=temporary_root) as directory:
        root = Path(directory).resolve()
        if not root.is_relative_to(workspace):
            raise ValueError("El proyecto de prueba debe quedar dentro del espacio de trabajo")
        yield root


class MasterTests(unittest.TestCase):
    def test_first_physical_row_owns_type_without_losing_other_types(self):
        equipment, stats = parse_master_rows([HEADERS, FIRST, SECOND])
        item = equipment["TEST01"]
        self.assertEqual(len(equipment), 1)
        self.assertEqual(item["tipo_equipo"], "CAMIÓN")
        self.assertEqual(item["fila_tipo"], 2)
        self.assertEqual(item["filas"], [2, 3])
        self.assertEqual(item["variantes"]["tipo_equipo"], ["CAMIÓN", "GRÚA"])
        self.assertEqual(item["ceco"], "2000")
        self.assertEqual(item["zona"], "Zona 2")
        self.assertEqual(stats["filas"], 2)
        self.assertEqual(stats["tipos_multiples"], 1)
        reversed_equipment, _ = parse_master_rows([HEADERS, SECOND, FIRST])
        self.assertEqual(reversed_equipment["TEST01"]["tipo_equipo"], "GRÚA")

    def test_header_offsets_placeholders_and_zone_names(self):
        row = ["SIN PATENTE", "ADMINISTRACION", "", "", "", ""]
        equipment, stats = parse_master_rows([["Título"], HEADERS, row,
                                              ["TEST-02", "ZONA 8 ASEO INDUSTRIAL", "Aseo", 3785.0, "BARREDORA", "ASEO"]])
        self.assertEqual(equipment["TEST02"]["zona"], "Zona 8")
        self.assertEqual(equipment["TEST02"]["ceco"], "3785")
        self.assertEqual(equipment["TEST02"]["fila_tipo"], 4)
        self.assertEqual(stats["sin_patente"], 1)
        self.assertEqual(plate_key(" test - 02 "), "TEST02")
        self.assertEqual(plate_key("Sin patente"), "")

    def test_other_conflicting_fields_do_not_choose_an_arbitrary_unit(self):
        other = list(SECOND)
        other[1], other[3], other[5] = "ZONA 3 RESITER", "3000", "OTRA UNIDAD"
        equipment, _ = parse_master_rows([HEADERS, FIRST, other])
        item = equipment["TEST01"]
        self.assertEqual(item["ceco"], "")
        self.assertEqual(item["zona"], "")
        self.assertEqual(item["unidad"], "")
        self.assertEqual(item["tipo_equipo"], "CAMIÓN")
        self.assertTrue(any("CECO ACTIVO FIJO ambiguo" in note for note in item["observaciones"]))

    def test_missing_or_duplicate_headers_are_rejected(self):
        for rows in ([["PATENTE", "CECO ACTUAL"], ["TEST01", 1000]],
                     [HEADERS + ["TIPO DECLARADO"], FIRST + ["GRÚA"]]):
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    parse_master_rows(rows)

    def test_asset_master_overrides_origin_fields_preserving_source(self):
        equipment, _ = parse_master_rows([HEADERS, FIRST, SECOND])
        source = transaction(**{"Zona": "Zona errónea", "Región": "Región origen",
                                "Línea de negocio": "Línea original", "Tipo de equipo": "OTRO TIPO"})
        row = normalize(source, "Prueba", CATALOG, equipment)
        self.assertEqual(row["ceco"], "2000")
        self.assertEqual(row["unidad"], "UNIDAD FIJA")
        self.assertEqual(row["zona"], "Zona 2")
        self.assertEqual(row["region"], "Región fija")
        self.assertEqual(row["linea"], "LÍNEA DEL EQUIPO")
        self.assertEqual(row["tipo_equipo"], "CAMIÓN")
        self.assertEqual(row["original"]["CECO"], "UNIDAD ORIGEN")
        self.assertEqual(row["unidad_origen"], "UNIDAD ORIGEN")
        self.assertTrue(row["atribucion_maestro"])

    def test_region_fallback_by_exact_master_name_does_not_replace_asset_code(self):
        first = list(FIRST)
        first[3] = "2000.0"
        equipment, _ = parse_master_rows([HEADERS, first])
        catalog = dict(CATALOG)
        catalog["2000"] = {"unidad": "UNIDAD FIJA", "ceco": "2000", "zona": "Zona 2"}
        catalog["unidadfija"] = {"ceco": "9999", "region": "Región por nombre exacto"}
        row = normalize(transaction(), "Prueba", catalog, equipment)
        self.assertEqual(row["ceco"], "2000")
        self.assertEqual(row["region"], "Región por nombre exacto")

    def test_loan_keeps_destination_and_asset_type_from_first_master_row(self):
        equipment, _ = parse_master_rows([HEADERS, FIRST, SECOND])
        row = normalize(transaction(**{"Préstamo": "Sí"}), "Prueba", CATALOG, equipment)
        self.assertEqual(row["ceco"], "3000")
        self.assertEqual(row["unidad"], "UNIDAD DESTINO")
        self.assertEqual(row["zona"], "Zona 3")
        self.assertEqual(row["region"], "Región destino")
        self.assertEqual(row["linea"], "LÍNEA DEL EQUIPO")
        self.assertEqual(row["tipo_equipo"], "CAMIÓN")
        self.assertFalse(row["atribucion_maestro"])
        self.assertEqual(row["maestro_equipo"]["ceco"], "2000")

    def test_unknown_plate_uses_existing_mapping_with_observation(self):
        row = normalize(transaction(), "Prueba", CATALOG, {})
        self.assertEqual(row["ceco"], "1000")
        self.assertEqual(row["unidad"], "UNIDAD ORIGEN")
        self.assertIn("Patente sin asociación en maestro de equipos", row["alertas"])
        self.assertIsNone(row["maestro_equipo"])

    def test_missing_line_never_reuses_division(self):
        for division in ("Mineria", "Minería", "Otra división", ""):
            with self.subTest(division=division):
                row = normalize(transaction(**{"División": division}), "Prueba", CATALOG)
                self.assertEqual(row["linea"], "Sin línea")
                self.assertEqual(row["division"], division)
        first = list(FIRST)
        first[2] = ""
        equipment, _ = parse_master_rows([HEADERS, first])
        row = normalize(transaction(**{"División": "Minería"}), "Prueba", CATALOG, equipment)
        self.assertEqual(row["linea"], "Sin línea")
        explicit = normalize(transaction(**{"Línea de negocio": "Línea informada"}), "Prueba", CATALOG)
        self.assertEqual(explicit["linea"], "Línea informada")

    def test_configured_relative_workbook_is_read_only_and_closed(self):
        with temporary_project() as root:
            (root / "config").mkdir()
            (root / "referencia.xlsx").write_bytes(b"fixture")
            (root / "config/maestro_equipos.json").write_text(
                json.dumps({"ruta": "referencia.xlsx", "hoja": "01 MAESTRO"}), encoding="utf-8")
            book = MagicMock()
            book.sheetnames = ["01 MAESTRO"]
            book.__getitem__.return_value.iter_rows.return_value = iter([HEADERS, FIRST, SECOND])
            with patch("openpyxl.load_workbook", return_value=book) as load:
                result = read_equipment_master(root)
            load.assert_called_once_with((root / "referencia.xlsx").resolve(), read_only=True, data_only=True)
            book.close.assert_called_once()
            book.save.assert_not_called()
            self.assertEqual(result["meta"]["patentes"], 1)
            self.assertEqual(result["equipos"]["TEST01"]["fila_tipo"], 2)
            self.assertIn("01 MAESTRO", result["equipos"]["TEST01"]["origen"])
            self.assertEqual((root / "referencia.xlsx").read_bytes(), b"fixture")

    def test_failed_master_read_keeps_previous_publication_and_database(self):
        with temporary_project() as root:
            (root / "Datos").mkdir()
            (root / "web/publicado").mkdir(parents=True)
            old_db = root / "Datos/combustible.sqlite"
            old_js = root / "web/publicado/combustible.js"
            old_db.write_bytes(b"base anterior")
            old_js.write_bytes(b"publicacion anterior")
            with patch("app.datos.read_equipment_master", side_effect=ValueError("maestro no disponible")):
                with self.assertRaisesRegex(ValueError, "maestro no disponible"):
                    update(root)
            self.assertEqual(old_db.read_bytes(), b"base anterior")
            self.assertEqual(old_js.read_bytes(), b"publicacion anterior")
            self.assertFalse((root / "Datos/actualizacion.lock").exists())

    def test_update_imports_full_master_without_creating_fuel_records(self):
        equipment, stats = parse_master_rows([HEADERS, FIRST, SECOND,
                                              ["OTRO02", "ZONA 1 RESITER", "Línea", 1000, "CAMIONETA", "UNIDAD ORIGEN"]])
        master = {"equipos": equipment, "meta": stats}
        with temporary_project() as root:
            (root / "Fuentes").mkdir()
            rows = [transaction(), transaction(**{"Préstamo": "Sí", "Hora": "11:00:00"})]
            with (root / "Fuentes/prueba.csv").open("w", encoding="utf-8", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=rows[0], delimiter=";")
                writer.writeheader()
                writer.writerows(rows)
            with patch("app.datos.read_equipment_master", return_value=master), patch("app.datos.read_catalog", return_value=CATALOG):
                payload = build_payload(root)
                publish(payload, root)
            self.assertEqual(len(payload["registros"]), 2)
            self.assertEqual(sum(row["galones"] for row in payload["registros"]), 100)
            self.assertEqual({row["ceco"] for row in payload["registros"]}, {"2000", "3000"})
            self.assertEqual(payload["maestro_equipos"]["meta"]["registros_asociados"], 2)
            self.assertEqual(read_publication(root), payload)
            with closing(sqlite3.connect(root / "Datos/combustible.sqlite")) as database:
                imported = database.execute("SELECT patente, tipo_equipo FROM maestro_equipos ORDER BY patente").fetchall()
                self.assertEqual(imported, [("OTRO02", "CAMIONETA"), ("TEST01", "CAMIÓN")])


if __name__ == "__main__":
    unittest.main()
