param([ValidateSet('iniciar','actualizar','instalar')][string]$Accion = 'iniciar')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$taskCandidates = @(
    @{Cmd='py'; Args=@('-3')},
    @{Cmd='python'; Args=@()},
    @{Cmd=(Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'); Args=@()}
)
$taskPython = $null
foreach ($taskCandidate in $taskCandidates) {
    if (-not (Get-Command $taskCandidate.Cmd -ErrorAction SilentlyContinue)) { continue }
    $taskExe = $taskCandidate.Cmd
    $taskPrefix = $taskCandidate.Args
    try {
        & $taskExe @taskPrefix -c 'import sys; sys.exit(sys.version_info < (3,10))' 2>$null
        if ($LASTEXITCODE -eq 0) { $taskPython = $taskCandidate; break }
    } catch { continue }
}
if (-not $taskPython) { Write-Host 'Se requiere Python 3.10 o superior.'; exit 1 }
$taskExe = $taskPython.Cmd
$taskPrefix = $taskPython.Args
if ($Accion -eq 'instalar') {
    & $taskExe @taskPrefix -m pip install -r config/requirements.txt
    exit $LASTEXITCODE
}
& $taskExe @taskPrefix -c 'import openpyxl' 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host 'Falta openpyxl. Ejecuta Iniciar_Primera_Vez.bat.'; exit 1 }
if ($Accion -eq 'actualizar') { & $taskExe @taskPrefix -B -m app.actualizar_BD }
else { & $taskExe @taskPrefix -B -m app.servidor }
exit $LASTEXITCODE
