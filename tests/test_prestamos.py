"""Reglas de atribución por abastecimiento, sin usar datos reales."""
import csv
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from app.configuracion import default_configuration, unit_id
from app.datos import build_payload, normalize, publish, read_publication


ORIGIN = {"unidad": "UNIDAD ORIGEN", "ceco": "1000", "zona": "Zona 1",
          "region": "Región origen", "linea": "Línea origen"}
DESTINATION = {"unidad": "UNIDAD DESTINO", "ceco": "2000", "zona": "Zona 2",
               "region": "Región destino", "linea": "Línea destino"}
CATALOG = {"unidadorigen": ORIGIN, "1000": ORIGIN,
           "unidaddestino": DESTINATION, "2000": DESTINATION}


def source(**changes):
    row = {"Fecha": "2026-10-01", "Hora": "10:00:00", "Placa": "TEST-01",
           "CECO": "UNIDAD ORIGEN", "Galones": 50, "KM Recorridos": 100,
           "Préstamo": "Sí", "CECO préstamo": "UNIDAD DESTINO"}
    row.update(changes)
    return row


class LoanAttributionTests(unittest.TestCase):
    def test_yes_variants_attribute_only_to_destination(self):
        for value in ("Sí", "Si", "SI", " sí ", " si "):
            with self.subTest(value=value):
                row = source(**{"Préstamo": value})
                record = normalize(row, "Prueba", CATALOG)
                self.assertEqual(record["unidad"], "UNIDAD DESTINO")
                self.assertEqual(record["unidad_origen"], "UNIDAD ORIGEN")
                self.assertEqual(record["ceco"], "2000")
                self.assertEqual(record["zona"], "Zona 2")
                self.assertEqual(record["region"], "Región destino")
                self.assertEqual(record["original"]["CECO"], "UNIDAD ORIGEN")
                self.assertEqual(record["original"]["CECO préstamo"], "UNIDAD DESTINO")
                self.assertEqual(record["galones"], 50)
                self.assertTrue(record["atribucion_prestamo"])

    def test_non_loan_keeps_original_unit_despite_destination(self):
        for value in ("No", "", None):
            with self.subTest(value=value):
                record = normalize(source(**{"Préstamo": value}), "Prueba", CATALOG)
                self.assertEqual(record["unidad"], "UNIDAD ORIGEN")
                self.assertEqual(record["ceco"], "1000")
                self.assertEqual(record["zona"], "Zona 1")
                self.assertFalse(record["atribucion_prestamo"])

    def test_numeric_destination_replaces_explicit_origin_code_and_geography(self):
        for value in ("2000", 2000, 2000.0):
            with self.subTest(value=value):
                row = source(**{"CECO": 1000, "Unidad": "UNIDAD ORIGEN",
                                "Código CeCo": "1000", "CECO préstamo": value,
                                "Zona": "Zona original explícita",
                                "Región": "Región original explícita",
                                "Línea de negocio": "Línea original explícita"})
                record = normalize(row, "Prueba", CATALOG)
                self.assertEqual(record["unidad"], "UNIDAD DESTINO (2000)")
                self.assertEqual(record["ceco"], "2000")
                self.assertEqual(record["zona"], "Zona 2")
                self.assertEqual(record["region"], "Región destino")
                self.assertEqual(record["linea"], "Línea destino")
                self.assertEqual(record["original"]["CECO"], "1000")

    def test_missing_destination_is_observed_without_charging_origin(self):
        record = normalize(source(**{"CECO préstamo": " "}), "Prueba", CATALOG)
        self.assertEqual(record["unidad"], "SIN UNIDAD")
        self.assertEqual(record["ceco"], "")
        self.assertEqual(record["zona"], "SIN ZONA")
        self.assertEqual(record["region"], "Sin región")
        self.assertTrue(any("sin CECO préstamo" in issue for issue in record["alertas"]))

    def test_unknown_destination_does_not_inherit_origin_geography(self):
        for value, expected_code in (("DESTINO NUEVO", ""), ("9999", "9999")):
            with self.subTest(value=value):
                row = source(**{"CECO préstamo": value, "Zona": "Zona 1",
                                "Región": "Región origen"})
                record = normalize(row, "Prueba", CATALOG)
                self.assertEqual(record["unidad"], value)
                self.assertEqual(record["ceco"], expected_code)
                self.assertEqual(record["zona"], "SIN ZONA")
                self.assertEqual(record["region"], "Sin región")

    def test_destination_catalog_ambiguity_is_retained(self):
        ambiguous = dict(DESTINATION)
        ambiguous.pop("region")
        ambiguous["observaciones"] = ["Región ambigua en el catálogo: A / B"]
        record = normalize(source(**{"Región": "Región origen"}), "Prueba",
                           dict(CATALOG, unidaddestino=ambiguous))
        self.assertEqual(record["region"], "Sin región")
        self.assertIn(ambiguous["observaciones"][0], record["alertas"])

    def test_destination_csv_overrides_apply_by_code_and_name(self):
        catalog = dict(CATALOG)
        catalog["2000"] = dict(DESTINATION, csv_override={"region": "Región corregida"})
        catalog["unidaddestino"] = dict(DESTINATION, csv_override={"zona": "Zona corregida"})
        record = normalize(source(), "Prueba", catalog)
        self.assertEqual(record["zona"], "Zona corregida")
        self.assertEqual(record["region"], "Región corregida")

    def test_publication_filters_and_database_use_per_record_attribution(self):
        workspace = Path(__file__).resolve().parents[1]
        temporary_root = workspace / "tmp"
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="prestamos-", dir=temporary_root) as directory:
            root = Path(directory)
            self.assertTrue(root.resolve().is_relative_to(workspace))
            (root / "Fuentes").mkdir()
            first = source(**{"Préstamo": "No", "Hora": "09:00:00"})
            second = source(**{"Galones": 75, "KM Recorridos": 150})
            with (root / "Fuentes/prueba.csv").open("w", encoding="utf-8", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=first, delimiter=";")
                writer.writeheader()
                writer.writerows([first, second])
            configuration = default_configuration()
            configuration["modos"]["zona"]["unidades"][unit_id("Zona 1", "UNIDAD ORIGEN")] = False
            configuration["modos"]["region"]["grupos"]["Región destino"] = False
            with patch("app.datos.read_equipment_master", return_value={"equipos": {}, "meta": {}}), patch(
                    "app.datos.read_catalog", return_value=CATALOG), patch(
                    "app.datos.read_configuration", return_value=configuration):
                payload = build_payload(root)
                publish(payload, root)
            rows = payload["registros"]
            self.assertEqual(len(rows), 2)
            self.assertEqual({r["placa"] for r in rows}, {"TEST-01"})
            self.assertEqual(sum(r["galones"] for r in rows), 125)
            self.assertEqual({r["unidad"] for r in rows}, {"UNIDAD ORIGEN", "UNIDAD DESTINO"})
            loans = [r for r in rows if r["atribucion_prestamo"]]
            normal = [r for r in rows if not r["atribucion_prestamo"]]
            self.assertEqual(payload["visibilidad"]["zona"], [loans[0]["id"]])
            self.assertEqual(payload["visibilidad"]["region"], [normal[0]["id"]])
            self.assertEqual(read_publication(root), payload)
            with closing(sqlite3.connect(root / "Datos/combustible.sqlite")) as database:
                stored = database.execute("SELECT unidad, contenido FROM registros").fetchall()
            self.assertEqual({unit for unit, _ in stored}, {"UNIDAD ORIGEN", "UNIDAD DESTINO"})
            self.assertTrue(all(json.loads(content)["original"]["CECO"] == "UNIDAD ORIGEN"
                                for _, content in stored))


if __name__ == "__main__":
    unittest.main()
