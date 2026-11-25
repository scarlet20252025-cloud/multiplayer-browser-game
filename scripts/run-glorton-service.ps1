[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RuntimeRoot,
    [ValidateRange(1, 65535)]
    [int]$Port = 18746,
    [string]$LogFile,
    [switch]$BrowserMultiplayer
)

$ErrorActionPreference = 'Stop'
$runtime = (Resolve-Path -LiteralPath $RuntimeRoot).ProviderPath
$source = Join-Path $runtime 'source'
$dependencies = Join-Path $runtime 'deps'
$python = Join-Path $runtime 'python\python.exe'

foreach ($file in @($python, (Join-Path $runtime 'python\python313.dll'),
    (Join-Path $source 'assets\manifests\glorton_manifest.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Provision the pinned runtime before starting Glorton. Missing $file"
    }
}
if (-not (Test-Path -LiteralPath $dependencies -PathType Container)) {
    throw 'The isolated Glorton dependency directory is missing.'
}

# Upstream v0.95-online, commit 61f5f27cbae71f36b423cf5ce784932148bd9777.
$checksums = @{
    'online\server.py' = 'D974F85447A2F9BC90D775653D7CAFD3BB99A9833B096890932BBCC635FABA96'
    'online\room.py' = '8A92AF3165533A71F28156B50EA72651B93FF185606286F06D9B0763B15FCD88'
    'src\simulation.py' = '0B7333607A35237CBC91119ACA83F86469EE863F93CF8B0F14CCDCFB3AE51956'
    'tools\install_runtime_assets.py' = 'E303C1686E2C59A6E84AF3C3CA4DA37B467D78F7B609D1FD687947550AC07E12'
}
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    foreach ($entry in $checksums.GetEnumerator()) {
        $file = Join-Path $source $entry.Key
        $actual = [BitConverter]::ToString($sha256.ComputeHash([IO.File]::ReadAllBytes($file))).Replace('-', '')
        if ($actual -ne $entry.Value) {
            throw "Glorton upstream checksum mismatch for $($entry.Key)."
        }
    }
} finally {
    $sha256.Dispose()
}
if ($LogFile) {
    $LogFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogFile)
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $LogFile) -PathType Container)) {
        throw 'The Glorton log directory is missing.'
    }
}

$env:GLORTON_ASSET_SCALE = '1'
$env:SDL_VIDEODRIVER = 'dummy'
$env:SDL_AUDIODRIVER = 'dummy'
$env:PYGAME_HIDE_SUPPORT_PROMPT = '1'

# Embedded Python ignores PYTHONPATH. Supply only the two provisioned import roots.
$entryPoint = @'
import runpy
import sys

source, dependencies, entry = sys.argv[1:4]
sys.path[:0] = [source, dependencies]
del sys.argv[1:4]
if entry == 'uvicorn':
    runpy.run_module(entry, run_name='__main__')
else:
    runpy.run_path(entry, run_name='__main__')
'@
$arguments = @('-I', '-B', '-u', '-c', $entryPoint, $source, $dependencies)
if ($BrowserMultiplayer) {
    $entry = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'glorton-multiplayer-authority.py')).ProviderPath
    $arguments += @($entry, '--port', "$Port")
} else {
    $arguments += @('uvicorn', 'online.server:app', '--host', '127.0.0.1', '--port', "$Port",
        '--no-proxy-headers', '--ws', 'websockets', '--ws-max-size', '16384',
        '--ws-max-queue', '8', '--no-access-log')
}

Push-Location -LiteralPath $source
try {
    # Windows PowerShell 5.1 presents redirected native stderr as errors.
    $ErrorActionPreference = 'Continue'
    if ($LogFile) {
        & $python @arguments *>> $LogFile
    } else {
        & $python @arguments
    }
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($exitCode -ne 0) { exit $exitCode }
