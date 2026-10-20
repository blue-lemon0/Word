package com.wordbank.app;

import android.annotation.SuppressLint;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

/**
 * 词库 · 背单词 —— 壳。
 *
 * <p>为什么不是 Trusted Web Activity：TWA 要域名所有权校验（assetlinks.json），
 * 那是给「有公网域名的 PWA」用的。这个 app 要的是**装上就能用、断网能背**，
 * 所以直接把构建产物塞进 assets，用 WebViewAssetLoader 挂在虚拟 https 域名下。
 *
 * <p>关键的三处设置，少一处就出功能问题：
 * <ul>
 *   <li>DOM storage —— IndexedDB 依赖它，不开就是「装上没数据」</li>
 *   <li>ServiceWorkerController —— service worker 发的请求走不到
 *       WebViewAssetLoader 的拦截，sw.js 注册成功后反而会把离线能力弄坏</li>
 *   <li>虚拟域名 https://appassets.androidplatform.net —— 必须是 https，
 *       否则 SW / crypto.randomUUID / 某些存储 API 直接不可用</li>
 * </ul>
 */
public class MainActivity extends android.app.Activity {

    private static final String DOMAIN = "appassets.androidplatform.net";
    /**
     * 构建产物就放在 APK 的 assets/ 根下（dist 里自带 assets/ 子目录给 vite 的
     * 打包文件），所以 pathPrefix 用 "/"：URL /index.html → assets/index.html，
     * URL /assets/index-xxx.js → assets/assets/index-xxx.js。两边正好对上。
     */
    private static final String START = "https://" + DOMAIN + "/index.html";
    /** 同一份 assets 的备用域：SW 的 CORS 预检会打到它 */
    private static final String DOMAIN_BACKUP = "appassets-backup.androidplatform.net";

    private WebView web;

    /** 网页里 <input type=file> 的回调；等 onActivityResult 回来喂它结果。 */
    private android.webkit.ValueCallback<android.net.Uri[]> filePathCallback;
    private static final int REQ_PICK_FILE = 4101;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(DOMAIN)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        final WebViewAssetLoader backup = new WebViewAssetLoader.Builder()
                .setDomain(DOMAIN_BACKUP)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        // 原生桥：导出备份可以直接调起系统分享面板（微信/QQ/保存），
        // 而不是把文件丢进一个用户找不到的目录。浏览器/PWA 环境里
        // window.WBNative 不存在，页面会优雅降级到 Web Share API。
        web.addJavascriptInterface(new NativeBridge(this), "WBNative");
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // IndexedDB 的开关
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);   // 资源全在本地，没有可搜的远程页面
        }

        // service worker 自己发的请求也要能被 assets 拦到，否则离线就断
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat sw = ServiceWorkerControllerCompat.getInstance();
            sw.getServiceWorkerWebSettings().setAllowFileAccess(false);
            sw.getServiceWorkerWebSettings().setAllowContentAccess(false);
            sw.setServiceWorkerClient(new ServiceWorkerClientCompat() {
                @Override
                public android.webkit.WebResourceResponse shouldInterceptRequest(
                        android.webkit.WebResourceRequest request) {
                    if ("/__log".equals(request.getUrl().getPath())) {
                        return handleLogRequest(request.getUrl());
                    }
                    android.webkit.WebResourceResponse r =
                            loader.shouldInterceptRequest(request.getUrl());
                    return r != null ? r : backup.shouldInterceptRequest(request.getUrl());
                }
            });
        }

        web.setWebViewClient(new android.webkit.WebViewClient() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view, android.webkit.WebResourceRequest request) {
                if ("/__log".equals(request.getUrl().getPath())) {
                    return handleLogRequest(request.getUrl());
                }
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // 页面这会儿才真的能接收事件（之前 evaluateJavascript 会被丢掉）
                if (pendingFile != null) {
                    readIncomingFile(pendingFile);
                    pendingFile = null;
                }
            }
        });

// 把页面的 console / 报错接到 logcat。没有它，真机上出问题时
        // 只能看到「白屏 / 没反应」，看不到一行 JS 报错 —— 排查等于瞎猜。
        //
        // 为什么不靠 WebChromeClient.onConsoleMessage：新 Android SDK 已经把
        // WebSettings.setLogLevel / LOG_LEVEL_VERBOSE 移除了，而 Chromium 默认只把
        // ERROR/WARNING 级的 console 转过来，console.log 全被丢掉 ——
        // 表现是「桥接写好了、日志一条都没有」，比不桥接还误导人。
        // 所以页面用 fetch('/__log?...') 主动把日志送出来，这里拦截并打进 logcat。
        // 查的时候：adb logcat -s wordbank:*
        WebView.setWebContentsDebuggingEnabled(true);
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                android.util.Log.d("wordbank", "console " + m.messageLevel() + " " + m.message());
                return true;
            }

            /**
             * ★ 「导入」能不能用，全看这个方法在不在。
             *
             * <p>网页里选文件是 {@code <input type=file>.click()}。在普通浏览器里
             * 这会弹系统文件选择器，但 WebView 默认**什么都不做** ——
             * 没有 WebChromeClient 就没有人替它拉起 Activity，于是页面上那个
             * click() 悄无声息地失败：按钮按下去毫无反应，网页侧也没有任何报错。
             * 之前「导入备份」「导入内容包」两个入口全是这么哑掉的。
             *
             * <p>几个必须做对的点：
             * <ul>
             *   <li>{@code filePathCallback} 每次都要先给上一次回调 null：
             *       否则上一次还在等结果的 input 会永远卡在「选择中」；</li>
             *   <li>用户取消时也要回调 null，否则 input 永远 pending；</li>
             *   <li>mime 设成通配符（星号、斜杠、星号）：限定 application/json 的话，
             *       早期版本导出的 .vwbak（系统不认识这个后缀）在文件列表里会被
             *       过滤掉，用户根本选不回来。</li>
             * </ul>
             */
            @Override
            public boolean onShowFileChooser(WebView view,
                                              android.webkit.ValueCallback<android.net.Uri[]> callback,
                                              FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                android.content.Intent i =
                        new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(android.content.Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(i, REQ_PICK_FILE);
                    return true;
                } catch (Exception e) {
                    android.util.Log.e("wordbank", "拉起文件选择器失败", e);
                    filePathCallback = null;
                    return false;
                }
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(0xFFF7F7F9);
        root.addView(web);
        setContentView(root);

        applySystemBars();
        watchIme(root);
        web.loadUrl(START);
        // 从微信/QQ 里点开一个 .json 备份就直接进 app 导入，
        // 不用「另存为 → 去文件管理器大海捞针」。
        handleIncomingFile(getIntent());
    }

    /* ── 朗读（TextToSpeech）──
     *
     * WebView 的 speechSynthesis 在 Android 上基本不可用（voice 列表为空），
     * 单词 / 例句的朗读只能由原生做。
     *
     * 两个要点：
     * <ol>
     *   <li>引擎初始化是异步的：第一次点朗读时引擎可能还没好，把那句话记在
     *       {@link #ttsPending} 里，onInit 成功后补读 —— 不然第一次点永远没声。</li>
     *   <li>setLanguage 要检查返回值：设备没装英文语音包时 speak() 不出声，
     *       只在 logcat 留一句话，别假装成功了。</li>
     * </ol>
     */
    private android.speech.tts.TextToSpeech tts;
    private boolean ttsReady = false;
    private String ttsPending;
    private float ttsPendingRate = 0.9f;

    /** NativeBridge.speak 转到这里。JavascriptInterface 跑在 binder 线程，先切回 UI 线程。 */
    void speak(final String text, final float rate) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (tts == null) {
                    ttsPending = text;
                    ttsPendingRate = rate;
                    tts = new android.speech.tts.TextToSpeech(MainActivity.this,
                            new android.speech.tts.TextToSpeech.OnInitListener() {
                                @Override
                                public void onInit(int status) {
                                    if (status != android.speech.tts.TextToSpeech.SUCCESS) {
                                        android.util.Log.w("wordbank", "TTS 初始化失败 status=" + status);
                                        return;
                                    }
                                    int r = tts.setLanguage(java.util.Locale.ENGLISH);
                                    ttsReady = r >= android.speech.tts.TextToSpeech.LANG_AVAILABLE;
                                    if (!ttsReady) {
                                        android.util.Log.w("wordbank", "TTS 没有英文语音包 r=" + r);
                                        return;
                                    }
                                    if (ttsPending != null) {
                                        speakNow(ttsPending, ttsPendingRate);
                                        ttsPending = null;
                                    }
                                }
                            });
                    return;
                }
                if (ttsReady) {
                    speakNow(text, rate);
                } else {
                    // 引擎还没好：只留最新的一句，别把队列越攒越长
                    ttsPending = text;
                    ttsPendingRate = rate;
                }
            }
        });
    }

    private void speakNow(String text, float rate) {
        if (tts == null) return;
        tts.setSpeechRate(rate);
        // QUEUE_FLUSH：背题时连点喇叭，听最新的一句，不排队
        tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "wb-speak");
    }

    void stopSpeak() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (tts != null) tts.stop();
            }
        });
    }

    @Override
    protected void onDestroy() {
        // TTS 持有系统服务连接，不 shutdown 会泄漏到进程结束
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        super.onDestroy();
    }

    /**
     * 处理 VIEW intent 传来的文件。
     *
     * <p>关键在 timing：{@code loadUrl} 之后立刻 evaluateJavascript，
     * 页面脚本还没跑、{@code window.WBNative} 还不存在，调用会被静默丢弃。
     * 所以先把 intent 记下来，等 {@code onPageFinished} 再真正投递。
     */
    private android.net.Uri pendingFile;

    private void handleIncomingFile(android.content.Intent intent) {
        if (intent == null) return;
        android.net.Uri uri = intent.getData();
        if (uri != null) pendingFile = uri;
    }

    private void readIncomingFile(android.net.Uri uri) {
        try (java.io.InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return;
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            final String text = new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
            final String name = uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "backup.json";
            final String js = "window.dispatchEvent(new CustomEvent('wb:import-file'," +
                    "{detail:{name:" + jsonString(name) + ",text:" + jsonString(text) + "}}))";
            web.evaluateJavascript(js, null);
        } catch (Exception e) {
            android.util.Log.e("wordbank", "读取传入的备份文件失败", e);
        }
    }

    /**
     * 从原生往页面里执行一段 JS（AI 的原生网络请求回调走这条）。
     *
     * <p>必须切到 UI 线程再 evaluate：WebView 的方法只能在创建它的线程调用。
     * 用 {@code evaluateJavascript} 而不是 {@code loadUrl("javascript:...")} ——
     * 后者会走一遍导航逻辑，对正在跑的应用来说是不必要的副作用。
     */
    void evalJs(final String js) {
        if (web == null) return;
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(js, null);
            }
        });
    }

    static String jsonString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

/**
 * 状态栏与导航栏。
 *
 * <p>★ 这里踩过一整轮弯路，最后的结论是：**不要 LAYOUT_FULLSCREEN**。
 *
 * <p>原本为了「沉浸式」设了 LAYOUT_FULLSCREEN + LAYOUT_HIDE_NAVIGATION，
 * 页面顶到状态栏底下、用透明状态栏。三个后果：
 * <ol>
 *   <li>半透明/透明状态栏在浅色页面上会「露馅」—— 系统图标、时钟
 *       直接压在内容上，中间还隔着一层不均匀的毛玻璃，很难看；</li>
 *   <li>为了让内容不被时钟盖住，网页侧要自己加 38px 的
 *       {@code padding-top: env(safe-area-inset-top)} 硬凑，量对量错都别扭；</li>
 *   <li>最要命的是 <b>键盘测不到</b>：全屏标志会让 IME insets 被系统消费掉，
 *       而且全屏下 WebView 尺寸永远不变、insets 不会重分发 ——
 *       网页侧 {@code visualViewport.height / innerHeight} 全都纹丝不动，
 *       键盘盖住输入框时 JS 里连一个异常都没有。只能改成原生每 250ms
 *       轮询 {@code getRootWindowInsets()} 再推给页面。</li>
 * </ol>
 *
 * <p>现在改成系统默认的「不覆盖」布局：状态栏<strong>实色不透明</strong>，
 * WebView 从状态栏下方开始。于是：
 * <ul>
 *   <li>状态栏是干净的一块纯色，不再有毛玻璃和「露馅」；</li>
 *   <li>不需要网页侧再补 safe-area 顶部留白；</li>
 *   <li>{@code adjustResize} 终于生效，键盘弹起时 WebView 被压缩，
 *       {@code visualViewport.height} 会变小 —— 键盘避让退回标准做法即可，
 *       原生轮询只留作兜底。</li>
 * </ul>
 *
 * <p>状态栏颜色必须与页面顶部同色，否则纯色条和页面之间会出现一条
 * 明显接缝，比透明更难看。
 */
private void applySystemBars() {
    final android.view.Window w = getWindow();
    final int bg = 0xFFFBFBFE; // 与 style.css 的 --wb-bg 一致
    w.setStatusBarColor(bg);
    w.setNavigationBarColor(bg);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        w.setNavigationBarDividerColor(bg);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // R 之后这两个方法被 API 30 废弃，改用 WindowInsetsController 的 appearance
        android.view.WindowInsetsController c = w.getInsetsController();
        if (c != null) {
            // 浅色背景 → 深色图标。方向反了就是白图标压在白底上，等于没有。
            c.setSystemBarsAppearance(
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        }
    } else {
        w.getDecorView().setSystemUiVisibility(
                android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0));
    }
}

    /** 日志通道：页面 fetch('/__log?l=..&m=..')，这里接住打 logcat。
     *  返回空的 204 —— 页面不需要内容，只要这条请求别打到 assets 就算成功。 */
    private static android.webkit.WebResourceResponse handleLogRequest(android.net.Uri uri) {
        String level = uri.getQueryParameter("l");
        String msg = uri.getQueryParameter("m");
        if (msg != null) {
            android.util.Log.d("wordbank", "[" + (level == null ? "log" : level) + "] " + msg);
        }
        return new android.webkit.WebResourceResponse(
                "text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
    }

    /**
     * 当前输入法（键盘）占据的高度，单位 px；0 表示键盘收着。
     *
     * <p>为什么必须由原生提供：壳开了 LAYOUT_FULLSCREEN + adjustResize，
     * WebView 的 viewport <b>不会</b>被键盘压缩 —— 真机实测键盘弹起时
     * {@code visualViewport.height}、{@code innerHeight}、{@code clientHeight}
     * 全都还是 800（屏高 800，键盘占了 283），网页侧拿到的每个值都在骗人。
     * 所以键盘避让只能读系统 insets。
     *
     * <p>两个容易踩空的点：
     * <ol>
     *   <li>监听器要挂在 <b>自己的内容视图</b> 上，不是 DecorView ——
     *       insets 是沿这棵子树分发的，挂在 DecorView 上不一定收得到。</li>
     *   <li>{@code requestApplyInsets()} 必须在 view 已 attach 到 window
     *       之后调用。onCreate 里 view 还没 attach，那一次请求会被丢掉，
     *       表现为「监听器装好了但永远不回调」。所以要 post 一次。</li>
     * </ol>
     */
    private int imeHeight = 0;

    private void watchIme(final android.view.View target) {
        // 用 platform 的接口而不是 ViewCompat.OnApplyWindowInsetsListener ——
        // 后者是独立顶层接口（androidx.core.view.OnApplyWindowInsetsListener），
        // 不在 ViewCompat 里，写成嵌套类编译不过。
        // minSdk 24 < API 30，所以 ime 的取法要分支。
        target.setOnApplyWindowInsetsListener(new android.view.View.OnApplyWindowInsetsListener() {
            @Override
            public android.view.WindowInsets onApplyWindowInsets(
                    android.view.View v, android.view.WindowInsets insets) {
                updateIme(insets);
                return insets;
            }
        });
        // attach 之后再要一次，否则第一次会被丢掉
        target.post(new Runnable() {
            @Override
            public void run() {
                target.requestApplyInsets();
            }
        });

        // ★ 轮询兜底。insets 只在窗口/焦点等状态变化时重分发，
        // 而全屏模式下 WebView 尺寸从头到尾不变 —— 于是监听器装好了、
        // requestApplyInsets 也调了，键盘弹起却**一次都不会回调**
        // （实测 logcat 里一条 ime= 都没有）。所以不能只靠监听。
        // 250ms 一次：键盘动画本身就要几百毫秒，再密也只是白烧电。
        target.post(new Runnable() {
            @Override
            public void run() {
                android.view.WindowInsets insets = target.getRootWindowInsets();
                if (insets != null) updateIme(insets);
                target.postDelayed(this, 250);
            }
        });
    }

    private void updateIme(android.view.WindowInsets insets) {
        int h;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            h = insets.getInsets(android.view.WindowInsets.Type.ime()).bottom;
        } else {
            h = insets.getSystemWindowInsetBottom();
        }
        if (h != imeHeight) {
            imeHeight = h;
            android.util.Log.d("wordbank", "ime=" + h);
            pushIme();
        }
    }

    /** 把键盘高度推给页面。页面侧在 window.__wbKbInset 上监听。 */
    private void pushIme() {
        if (web == null) return;
        final int css = Math.round(imeHeight / getResources().getDisplayMetrics().density);
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(
                        "try{window.__wbKbInset&&window.__wbKbInset(" + css + ")}catch(e){}", null);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_FILE || filePathCallback == null) return;
        android.net.Uri[] uris = null;
        if (resultCode == android.app.Activity.RESULT_OK
                && data != null && data.getData() != null) {
            uris = new android.net.Uri[]{ data.getData() };
        }
        // 取消也要回调（null）：不回传的话网页那边的 Promise 永远 pending，
        // 表现是「点了导入，界面卡在半开的状态，再点也没反应」。
        filePathCallback.onReceiveValue(uris);
        filePathCallback = null;
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        // launchMode=singleTask：已在运行时会走这里而不是新建 Activity。
        // 不处理的话，从微信点文件打开时会被静默忽略（只剩页面闪一下）。
        setIntent(intent);
        handleIncomingFile(intent);
        if (pendingFile != null && web != null) {
            readIncomingFile(pendingFile);
            pendingFile = null;
        }
    }

    @Override
    public void onBackPressed() {
        // 交给前端路由处理；它没有可回退的历史时才真的退出
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}