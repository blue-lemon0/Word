import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
}

val keystorePropertiesFile = rootProject.file("keystore.properties")
val hasReleaseKeystore = keystorePropertiesFile.isFile
val keystoreProperties = Properties().apply {
    if (hasReleaseKeystore) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}

android {
    namespace = "com.wordbank.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.wordbank.app"
        // WebViewAssetLoader + ServiceWorkerController 需要 API 24 以上
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.2.0"
    }

    // 词库内容在运行时下载/导入，不塞进 APK
    androidResources {
        ignoreAssetsPattern = "app.web.*"
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        // assets 里的内容已经有自己的目录结构，别让 AGP 再压一层
        jniLibs.useLegacyPackaging = false
    }
}

dependencies {
    // WebViewAssetLoader + ServiceWorkerController 需要 API 24 以上
    implementation("androidx.webkit:webkit:1.12.1")
    // 原生桥（NativeBridge）要用 FileProvider / ClipboardManager，
    // 它们在 androidx.core 里；不引这一条编译会直接报找不到符号。
    implementation("androidx.core:core:1.13.1")
    // Edge TTS 的原生 WebSocket（android 没有公开的 java.net.http.HttpClient）
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}