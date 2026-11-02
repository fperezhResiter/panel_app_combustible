# Panel de combustible · Resiter Driver

Dashboard local construido con el esqueleto y el CSS del **Panel Reporte Codelco**. No depende de servicios externos ni bibliotecas web en internet.

## Uso

1. Abre **Panel.html** con doble clic. La pantalla de **Inicio** muestra las seis vistas disponibles, con el mismo formato de tarjetas del panel de Mantenimiento. Los cuatro registros iniciales del mensaje están marcados como muestra.
2. Deja tus Excel **.xls / .xlsx / .xlsm** o **CSV** dentro de **Fuentes**. Se incluyen subcarpetas; se omiten archivos temporales `~$`.
3. Ejecuta **Actualizar_BD.bat** y recarga el HTML. Para actualizar con un botón desde el navegador, ejecuta **Iniciar_Panel.bat**; abre `http://127.0.0.1:8765/Panel.html`. Mantén su ventana abierta.
4. En el modo interactivo, abre **Configuraciones** y selecciona las zonas o regiones y sus unidades. Cada casilla se guarda automáticamente en la BD; después pulsa **Actualizar BD** para aplicar las selecciones a la publicación. El HTML por doble clic muestra esa misma selección publicada en cada modo.

Python 3.10+ y openpyxl son necesarios para actualizar; los `.xls` binarios usan también xlrd. Las exportaciones `.xls` en XML de Excel se leen con Python directamente. Si falta alguna dependencia, ejecuta **Iniciar_Primera_Vez.bat**. La consulta por doble clic funciona sin Python. Los lanzadores detectan Python del equipo y, en este equipo, también el runtime disponible de Codex.

## Lo que incluye

- Inicio con acceso a **Resumen de combustible**, **Consumo y evolución**, **Rendimiento de equipos**, **Estado de abastecimientos**, **Registro de abastecimientos** y **Fuentes y criterios**. La navegación superior y **Volver al inicio** permiten cambiar de vista sin perder la selección de filtros. Cada vista también tiene un enlace directo mediante el fragmento de URL (`#resumen`, `#consumo`, `#rendimiento`, `#estados`, `#registros`, `#fuentes`).
- Resumen con indicadores de abastecimientos, consumo, equipos, rendimiento ponderado, pendientes y registros con observaciones, junto con la tabla expandible. Los gráficos se consultan en las vistas específicas para reducir la carga visual del resumen.
- Selector **Modo zona / Modo región** en cabecera. Filtros de mes, zona o región, unidad, línea (modo zona), tipo de unidad y placa; filtros adicionales de fecha, estado, abastecimiento, tipo de equipo y fuente, más búsqueda.
- **Consumo y evolución**: consumo por zona → unidad → línea → placa o región → unidad → placa e historial diario (mensual con más de 90 días). **Rendimiento de equipos**: gráfico por fecha/placa y tabla de rendimiento ponderado. **Estado de abastecimientos**: distribución de estados y recuentos de pendientes y observaciones. Hover y foco coordinan los registros relacionados de cada vista; seleccionar filtra el conjunto compartido por todas las vistas.
- Resumen expandible por zona o región y unidad, separado de los filtros. El botón Mostrar línea / Ocultar línea, después de Expandir todo, agrega el nivel Línea entre Unidad y Placa en ambos modos. Las líneas se muestran inicialmente contraídas y se expanden para ver sus equipos. El cambio de presentación conserva los filtros, los totales y la expansión previa de cada presentación. El PDF respeta la presentación elegida e incluye todas sus ramas. Tabla de equipos ordenable y registro paginado con detalle de las 24 columnas, asociaciones y enlaces GPS. Cada modo conserva su estado de expansión. Al cambiar de modo se retira el filtro territorial anterior y, en región, el de línea; los demás filtros se conservan cuando son compatibles.
- CSV de toda la selección filtrada, aunque las filas estén contraídas, con datos originales, asociaciones, observaciones, procedencia y filtros aplicados. Protege textos que Excel podría interpretar como fórmulas.
- **Descargar PDF** genera un informe de la vista activa con logo, fecha de publicación, período, filtros e indicadores. Incluye gráficos por tramos cuando son anchos y tablas nativas paginadas con encabezados repetidos; Resumen incluye todas las ramas y Registro todos los abastecimientos filtrados, aunque estén contraídos o en otras páginas. Funciona sin conexión y al abrir el HTML con doble clic, con la biblioteca local pdf-lib (licencia en web/vendor). Los datos y figuras se fijan al iniciar la descarga.
- Vista de fuentes y criterios, sin modificar los libros originales.
- **Configuraciones**, disponible en la navegación y en Inicio únicamente al ejecutar **Iniciar_Panel.bat**. Sus pestañas **Modo zona / Modo región** muestran los grupos y las unidades de los catálogos y de la publicación, incluidas las que aún no tienen abastecimientos y las que no tienen asociación. Cada casilla indica **Sí / No** y se guarda en SQLite al cambiarla. Se muestra cuántas unidades se incluirán en cada grupo y si hay cambios pendientes de aplicar.
- Las selecciones de zona y región son independientes. Desmarcar un grupo oculta todas sus unidades en ese modo y conserva la selección individual para cuando se vuelva a marcar. La selección se aplica antes de los filtros, los cálculos, los gráficos y las descargas CSV/PDF. **Limpiar** restablece filtros, conservando las exclusiones publicadas. **Recargar configuración** permite recoger cambios guardados desde otra ventana; las revisiones evitan sobrescribirlos accidentalmente.
- **Fuentes y criterios** incluye las instrucciones completas de **Actualizar_BD.bat**, preparación de fuentes y publicación de las selecciones solo en el modo interactivo. En consulta por doble clic se conservan los criterios, procedencia y calidad, y se ocultan las instrucciones operativas y Configuraciones.

## Fuentes y asociaciones

Se exige Fecha, Placa y Galones en la cabecera; se buscan en las primeras 30 filas de cada hoja. Las otras columnas del mensaje son opcionales. Las fórmulas se leen por su resultado guardado: abre y guarda el libro en Excel si sus resultados no están actualizados. Se leen directamente tanto los `.xls` binarios como los reportes `.xls` en XML de Excel 2003. En estos últimos se respetan las celdas combinadas y los índices de fila/columna; títulos y pies combinados se excluyen del registro. Las hojas de flota u odómetros sin Galones no se suman al consumo.

Los catálogos **config/cecos_zonas.json** (61 filas) y **config/cecos_regiones.json** (46 filas) conservan las tablas recibidas. Se enlazan por código o nombre exacto, tolerando mayúsculas/tildes. Los códigos combinados se consultan individualmente sin duplicar registros. La región operativa BHP se conserva tal como fue enviada. Los CeCo ausentes permanecen como `Sin código` en el JSON.

Completa **config/unidades.csv** si quieres establecer o corregir Zona, Región, Línea de negocio o Tipo de equipo: separador `;`, una fila por CECO (nombre o código), columnas opcionales. Para patentes sin datos del maestro, la prioridad es: columnas explícitas del Excel, CSV y catálogos JSON. Si falta línea, se muestra Sin línea; si falta zona o región, se muestra SIN ZONA o Sin región. Las ambigüedades no se resuelven por semejanza de nombres. Tipo unidad conserva Propia, Arrendada, etc.; no se interpreta como tipo de equipo.

La tabla regional contiene ANTUCOYA en Antofagasta y Calama, y códigos compartidos como 3290 y 3793; estos casos aparecen en **Fuentes y criterios → Asociaciones de zona y región**. COLLAHUASI II no tiene región en la tabla recibida y permanece en Sin región hasta completar su asociación. No se cambian los nombres de las fuentes. El CSV descargado incluye Unidad, código, Zona, Región y modo/filtros aplicados.

Los números admiten punto o coma decimal; si vienen ambos, el último es decimal. Un único separador es decimal. Por ejemplo, `262.14` y `262,14` representan 262,14. Se aceptan fechas Excel, AAAA-MM-DD y DD/MM/AAAA. El panel y sus descargas muestran Litros y km/L, conservando los valores numéricos de la fuente. La columna de origen Galones y las claves internas se mantienen para importar los archivos existentes. No se aplica una conversión numérica de unidades ni de moneda. El indicador de pendientes se presenta como Validación pendiente.

Se consolida cada fila idéntica entre archivos y hojas, conservando su procedencia. La misma fecha/hora/placa con valores distintos se conserva como conflicto por revisar. El directorio Fuentes es la foto completa: cada actualización sustituye la publicación a partir de todos los archivos presentes, en lugar de acumular importaciones anteriores. Conserva los archivos históricos que deban seguir apareciendo.

Cuando **Préstamo = Sí** (también Si/SI, con espacios o sin tilde), solo ese abastecimiento se atribuye a la unidad de **CECO préstamo**, indicada por nombre o código. Su código, zona, región y asociaciones se resuelven desde el destino; las dimensiones explícitas de la unidad original no prevalecen. La patente conserva su identidad y sus otros registros mantienen la atribución que corresponda a cada fila. Filtros, configuraciones, indicadores, tablas, gráficos y descargas usan la unidad atribuida. El detalle y el CSV conservan las columnas originales y muestran también la unidad atribuida. Si falta el destino, se muestra SIN UNIDAD con una observación; un destino sin catálogo conserva su nombre o código en SIN ZONA / Sin región.

## Maestro de equipos móviles

Cada ejecución de **Actualizar_BD.bat** o del botón **Actualizar BD** vuelve a leer **Maestro_Equipos_Moviles.xlsx**, hoja **01 MAESTRO**, en `../../../06. Mantenimiento/03 MAESTRO EQUIPOS MOVILES/`, relativa a la carpeta del panel. No depende del usuario de Windows. La ruta y la hoja pueden ajustarse en **config/maestro_equipos.json**. El maestro se abre solo para lectura y no se modifica.

Se asocian las patentes ignorando espacios y guiones. Se importan **ZONA**, **LINEA DE NEGOCIO**, **CECO ACTIVO FIJO** (código), **TIPO DECLARADO** (tipo de equipo) y, si está disponible, **FAENA ACTIVO FIJO** para el nombre de unidad. Las zonas como ZONA 2 RESITER o ZONA 8 ASEO INDUSTRIAL se muestran como Zona 2 y Zona 8 para conservar los filtros comunes. No se usa CECO ACTUAL en lugar del código fijo.

El maestro prevalece en los registros normales. En préstamos, la unidad, código, zona y región siguen siendo los del CECO préstamo del abastecimiento; el tipo se toma del maestro. La línea del destino, si está configurada, tiene prioridad en préstamos; en su ausencia se usa la línea del equipo. La región procede del catálogo de códigos o del nombre exacto de la faena del maestro.

Si una patente aparece varias veces, **TIPO DECLARADO se toma de su primera fila física en 01 MAESTRO**, según la regla acordada. Se conservan los números de fila y los tipos encontrados. Los conflictos de zona, línea o código se informan sin elegir una asociación arbitraria. Sin coincidencia, el abastecimiento conserva los datos y asociaciones de origen y se marca para revisión; no se elimina ni se duplica. Las filas del maestro sin patente no se cruzan.

SQLite guarda el catálogo importado completo de patentes en **maestro_equipos**, incluidas las que no tienen consumo. Los abastecimientos conservan el maestro asociado y las columnas originales. **Fuentes y criterios** muestra los recuentos del cruce; el detalle muestra la procedencia, el código fijo y la fila del tipo, y el CSV incluye esa trazabilidad. Si no se puede leer el maestro o faltan columnas obligatorias, se conserva la publicación y la BD anteriores. El modo `--muestra` sigue funcionando sin el archivo compartido.

## Datos y actualización

`app/` lee, valida y prepara el conjunto antes de escribir. Publica **web/publicado/combustible.js** para consulta por doble clic y **Datos/combustible.sqlite** como base de esta aplicación. La interfaz HTTP y la consulta estática leen el mismo artefacto de publicación. Un fallo de lectura, un archivo sin registros válidos de cabecera o una carpeta sin archivos conserva la publicación anterior. No se mezcla la muestra con los archivos reales.

Solo un proceso actualiza a la vez en este equipo mediante `Datos/actualizacion.lock`; no está diseñado para escritura simultánea entre equipos sobre una carpeta sincronizada. Si se interrumpe abruptamente una actualización, verifica que no haya otra en curso antes de retirar ese archivo de bloqueo. La publicación registra fecha y hora; la cabecera las muestra en horario de Chile.

La tabla **configuracion** de **Datos/combustible.sqlite** conserva las exclusiones por modo y su revisión. Guardar una casilla no cambia la publicación actual. **Actualizar BD** y **Actualizar_BD.bat** preservan esa tabla al reconstruir la BD y publican las listas de registros visibles de cada modo. La BD y la publicación conservan los registros de origen para permitir volver a mostrar unidades y revisar la calidad completa. Una BD anterior sin esta tabla empieza con todo incluido. Si la actualización falla, se conservan la publicación anterior y las selecciones guardadas, que siguen pendientes.

El guardado y la actualización comparten el mismo bloqueo. La API de escritura exige el origen del panel y el token de su servidor local; la consulta estática no puede escribir configuraciones.

## Cálculos

- Consumo = suma de litros numéricos ≥ 0. Los ausentes o inválidos no se vuelven cero.
- Rendimiento = suma de KM / suma de litros, solo sobre filas donde KM ≥ 0 y litros > 0. El rendimiento reportado se conserva y se compara con el calculado (tolerancia 0,011 para admitir el redondeo a dos decimales).
- Equipos activos = placas únicas no vacías en la selección; pendientes = estado Pendiente.
- Observaciones = registros con fecha/hora/placa o números inválidos, litros ausentes/no positivos, diferencia de rendimiento o conflicto de identidad. No se inventan umbrales operacionales.
- Precios y totales se conservan en la moneda rotulada por la fuente (S/.). Un total parcial muestra cuántos registros tienen importe.

## Estructura

`Panel.html` · `web/css/` · `web/js/` · `web/img/` · `web/publicado/` · `app/` · `Fuentes/` · `Datos/` · `config/`.

