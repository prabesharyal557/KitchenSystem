$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
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

Push-Location (Join-Path $projectRoot "android")
try {
  & .\gradlew.bat --no-daemon assembleDebug
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
