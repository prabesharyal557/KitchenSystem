param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $projectRoot "android"
$signingFile = Join-Path $androidRoot "signing.properties"
if (-not (Test-Path -LiteralPath $signingFile)) {
  throw "Missing android/signing.properties. Follow docs/ANDROID_RELEASE.md before building a production release."
}

$bundledJava = Get-ChildItem -LiteralPath (Join-Path $projectRoot ".jdk") -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "bin\java.exe") } |
  Select-Object -First 1
if ($bundledJava) {
  $env:JAVA_HOME = $bundledJava.FullName
} elseif (-not $env:JAVA_HOME) {
  throw "Install JDK 21 and set JAVA_HOME before building the Android app."
}

$env:GRADLE_USER_HOME = Join-Path $projectRoot ".gradle-apk"
$env:ANDROID_USER_HOME = Join-Path $projectRoot ".android-apk"
if (-not $SkipBuild) {
  Push-Location $androidRoot
  try {
    & .\gradlew.bat --no-daemon clean assembleRelease
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
}

$source = Join-Path $androidRoot "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path -LiteralPath $source)) { throw "The signed release APK was not produced." }
$destination = Join-Path $projectRoot "downloads\Sajilo-Restaurant-release.apk"
Copy-Item -LiteralPath $source -Destination $destination -Force
$stream = [IO.File]::OpenRead($destination)
try {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $checksum = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
} finally {
  $stream.Dispose()
  if ($sha256) { $sha256.Dispose() }
}
Set-Content -LiteralPath "$destination.sha256" -Value "$checksum  Sajilo-Restaurant-release.apk" -Encoding ascii
Write-Host "Release APK: $destination"
Write-Host "SHA-256: $checksum"
