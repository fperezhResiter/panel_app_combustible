"""Servidor local: solo recursos del panel y actualización desde la carpeta configurada."""
import argparse
import json
import secrets
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote
from .datos import ROOT, read_catalog, read_publication, update
from .configuracion import configuration_state, save_configuration


class Handler(SimpleHTTPRequestHandler):
    token = secrets.token_urlsafe(32)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def allowed_host(self):
        return self.headers.get("Host") in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}

    def do_GET(self):
        if not self.allowed_host():
            return self.reply(403, {"error": "Host no permitido"})
        path = unquote(urlsplit(self.path).path)
        if path == "/api/estado":
            return self.reply(200, {"token": self.token, "modo": "local"})
        if path == "/api/datos":
            try:
                return self.reply(200, read_publication())
            except Exception:
                return self.reply(503, {"error": "No hay una publicación disponible"})
        if path == "/api/configuracion":
            try:
                return self.reply(200, configuration_state(ROOT, read_publication(), read_catalog(ROOT)))
            except Exception as exc:
                return self.reply(503, {"error": str(exc)})
        if path in {"/", "/Panel.html"}:
            self.path = "/Panel.html"
        elif not (path.startswith("/web/") and path.endswith((".js", ".css", ".png"))):
            return self.reply(404, {"error": "Recurso no disponible"})
        resolved = (ROOT / path.lstrip("/")).resolve()
        if not resolved.is_relative_to((ROOT / "web").resolve()) and path not in {"/", "/Panel.html"}:
            return self.reply(404, {"error": "Recurso no disponible"})
        if path.endswith(".tmp"):
            return self.reply(404, {"error": "Recurso no disponible"})
        super().do_GET()

    def do_HEAD(self):
        # Do not expose folder listings or source metadata through HEAD.
        self.reply(405, {"error": "Método no disponible"})

    def do_POST(self):
        expected_origin = f"http://{self.headers.get('Host')}"
        if (not self.allowed_host() or self.headers.get("Origin") != expected_origin
                or not secrets.compare_digest(self.headers.get("X-Panel-Token", ""), self.token)):
            return self.reply(403, {"error": "Actualización permitida solo desde este panel local"})
        path = urlsplit(self.path).path
        if path not in {"/api/actualizar", "/api/configuracion"}:
            return self.reply(404, {"error": "Acción no disponible"})
        try:
            if path == "/api/configuracion":
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16384:
                    raise ValueError("El tamaño de la selección no es válido.")
                change = json.loads(self.rfile.read(length).decode("utf-8"))
                result = save_configuration(ROOT, change, read_publication(), read_catalog(ROOT))
                return self.reply(200, result)
            payload = update()
            return self.reply(200, payload)
        except Exception as exc:
            return self.reply(400, {"error": str(exc)})

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        print(f"No se pudo abrir el puerto {args.port}. Prueba --port 8766.")
        return 1
    url = f"http://127.0.0.1:{server.server_port}/Panel.html"
    print(f"Panel de combustible: {url}", flush=True)
    print("Mantén esta ventana abierta. Ctrl+C para detener.", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
