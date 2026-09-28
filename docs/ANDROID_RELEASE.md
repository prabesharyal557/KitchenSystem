# Sajilo Android production release

The public download must be a release-signed APK. The debug APK is only for local development.

## One-time move from the old debug APK

Version 1.5 is the first production-signed build. Android will not install it over an older debug-signed Sajilo APK because the signatures differ. Before moving a staff device, connect it to the internet, let every pending offline action synchronize, and confirm the pending count is zero. Then uninstall the old app once and install version 1.5. Keep using the same protected release key for every later build so future updates install in place and retain app data.

## One-time signing setup

1. Keep the signing material on a protected development machine and make an encrypted offline backup. Losing it prevents Android from accepting future updates over the installed app.
2. Generate a key with JDK 21:

   ```powershell
   keytool -genkeypair -v -keystore android/sajilo-release.jks -alias sajilo -keyalg RSA -keysize 4096 -validity 10000
   ```

3. Copy `android/signing.properties.example` to `android/signing.properties` and enter the keystore filename, alias, and passwords. Both the property file and keystore are ignored by Git.

## Build and verify

Update `versionCode` and `versionName` in `android/app/build.gradle` and `app-version.json`. `versionCode` must always increase.

Run:

```powershell
npm run android:release
```

This creates:

- `downloads/Sajilo-Restaurant-release.apk`
- `downloads/Sajilo-Restaurant-release.apk.sha256`

The Gradle release configuration disables debugging, enables R8 minification and resource shrinking, and requires release signing. Verify the signature with Android build tools:

```powershell
apksigner verify --verbose --print-certs downloads/Sajilo-Restaurant-release.apk
Get-FileHash downloads/Sajilo-Restaurant-release.apk -Algorithm SHA256
```

Compare the hash with the `.sha256` file before publishing. Run the complete test suite, install the APK on a staging Android device, test online/offline/reconnect, and then deploy the Worker assets. Never publish `app-debug.apk`.
