# Android 正式包与签名

> 当前只是**签名打包演练**，还没有发布。正式发布前先定项目名、应用名和
> `applicationId`；发布后再改包名等于换一个新 app，老用户收不到更新。

## 当前配置

| 项 | 值 |
|---|---|
| release applicationId | `com.wordbank.app`（debug 是 `com.wordbank.app.debug`） |
| versionCode / versionName | `4` / `0.3.2` |
| minSdk / targetSdk | `24` / `36` |
| R8 | release 开启，规则在 `app/android/app/proguard-rules.pro` |
| 签名配置 | 读取 `app/android/keystore.properties`（已 gitignore） |
| keystore | 本机在 `~/.android/wordbank-release/release-keystore.p12` |
| 证书 SHA-256 | `DF:17:EE:44:B0:A3:96:05:D5:F4:A5:F8:C0:71:90:01:22:98:D1:D4:71:B5:4C:B7:7D:A7:67:3F:8B:69:CE:4E` |

签名密钥是 RSA 4096 / SHA256withRSA，有效期到 2054-03-08。**密钥和
`keystore.properties` 都不要入库**；丢失后已安装的用户永远无法覆盖升级。

## 出新包

```bash
cd app/web
npm run apk:release
```

产物：

- `app/android/app/build/outputs/apk/release/app-release.apk`（约 899 KB，侧载用）
- `app/android/app/build/outputs/bundle/release/app-release.aab`（约 1066 KB，上架用）

release **默认不安装**。需要装到真机时显式加 `--install`：

```bash
node scripts/build_apk.mjs --release --aab --install
```

release 和 debug 的包名不同，可以并存在同一台手机上；但两者的本地数据不互通。

## 新机器怎么恢复签名

1. 从加密备份恢复整个 `~/.android/wordbank-release/`（keystore + properties）。
2. 复制 `app/android/keystore.properties.example` 为
   `app/android/keystore.properties`，把 `storeFile` 改成恢复后的绝对路径。
3. 从仓库根确认密钥：

   ```powershell
   $env:JAVA_HOME = "D:\software\Android\Android Studio\jbr"
   & "$env:JAVA_HOME\bin\keytool.exe" -list -v `
     -keystore "$env:USERPROFILE\.android\wordbank-release\release-keystore.p12" `
     -alias wordbank-release
   ```

4. 跑 `npm run apk:release`。脚本会用 `apksigner` 验证 APK 签名。

没有 `keystore.properties` 时，Gradle 仍可产出未签名 release 包，但
`npm run apk:release` 会直接报错并提示参考 example 配置，避免把未签名包当正式包。

## 上架 Google Play

- 上传 `.aab`，不要上传 APK。新应用走 **Play App Signing**：
  当前 keystore 作为 upload key，真正的 app signing key 由 Google 保管。
- 每次发布都要递增 `versionCode`；上传后版本号不能复用。
- `jarsigner -verify` 对 AAB 会报 JAR 一致性/自签名证书警告，这是 AAB 格式本身
  和自签名证书导致的；退出码为 0 即可，最终以上传 Play Console 的校验结果为准。
- 如果以后要换 upload key，可在 Play Console 申请重置；**app signing key 丢失
  才是灾难**，所以启用 Play App Signing 后仍要备份 upload key。

## 改名 / 开源检查清单

当前 `wordbank`、`极简单词`、`com.wordbank.app` 都是演练身份，正式发布前一次定好：

- 显示名：`app/android/app/src/main/res/values/strings.xml` 的 `app_name`、
  `app/web/index.html` 的 title / apple title、`app/web/public/manifest.webmanifest`
- 工程名：`app/android/settings.gradle.kts` 的 `rootProject.name`
- 包名：`namespace` / `applicationId`；如果改 `namespace`，Kotlin 包目录和
  `MainActivity.kt` 的 `package` 也要同步，否则 manifest 的 `.MainActivity` 找不到类
- PWA：`manifest.webmanifest` 的 `id`、`short_name`、`name`，以及 `public/sw.js`
  的缓存名；否则新旧 PWA 缓存可能互相覆盖
- **applicationId 一改就是另一个 app**，已安装用户无法覆盖升级；一旦上架就不能
  再改包名，只能改显示名。签名证书与包名无关，改名后可以继续用同一把密钥。
- 开源前分开确认：代码 LICENSE、词库/例句内容来源与许可证、`seed.json` 是否可
  再分发、AI API key 与 `keystore.properties` 不在仓库、README 里的本机绝对路径
  是否要改成通用说明。

## 发布前必须确认

- **名称与包名**：项目名、桌面显示名、仓库名、`applicationId` 一次定好。尤其
  `com.wordbank.app` 是占位身份，不要等上架后才发现要改名。
- **版本号**：每次发布 `versionCode` 必须递增；`versionName` 用语义化版本。
- **签名备份**：keystore 与密码至少两份加密备份，密码不要只存在聊天记录里。
- **开源授权**：代码许可证、词库/例句内容来源与许可证要分开确认；不要在没有
  授权结论前把内容包一起公开。
- **真机回归**：release 开了 R8，至少验证启动、训练、导入、备份、AI 请求、
  WebView 原生桥和 TTS。`NativeBridge` 的 `@JavascriptInterface` 方法已在
  proguard 里显式保留，不要删那条规则。
- **AAB 校验**：`jarsigner -verify` 可能提示 JAR 内部一致性和自签名证书警告，
  但正常签名时退出码为 0；上架以 Play Console 的校验结果为准。
