import argparse
import sys
from .datos import update


def main():
    parser = argparse.ArgumentParser(description="Actualizar el panel desde Fuentes sin modificar los Excel")
    parser.add_argument("--muestra", action="store_true", help="Publicar solo los cuatro registros de muestra")
    args = parser.parse_args()
    try:
        result = update(sample=args.muestra)
        print(f"Publicados {len(result['registros'])} registros. Duplicados consolidados: {result['duplicados']}.")
        print(f"Registros visibles: modo zona {len(result['visibilidad']['zona'])}; "
              f"modo región {len(result['visibilidad']['region'])}.")
        master = result.get("maestro_equipos", {}).get("meta", {})
        if master.get("archivo"):
            print(f"Maestro: {master['patentes']} patentes importadas de {master['archivo']} / {master['hoja']}.")
            print(f"Abastecimientos asociados: {master['registros_asociados']}; "
                  f"sin asociación: {master['registros_sin_asociacion']} ({master['patentes_sin_asociacion']} patentes).")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
