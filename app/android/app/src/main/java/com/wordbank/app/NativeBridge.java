package com.wordbank.app;

import android.content.Intent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

/**
 * 页面与 Android 之间的桥。注入名 {@code WBNative}。
 *
 * <p>存在的理由只有一个：**移动端上「把文件存下来」是反直觉的**。
 * 网页的 {@code <a download>} 在手机上可能什么都不发生，也可能塞进一个
 * 用户找不到的目录 —— 于是「导出备份」变成了「导出完去文件管理器大海捞针」。
 * 这里把文件写进 cacheDir，再用 {@link FileProvider} 发出去，
 * 系统分享面板一弹，微信 / QQ / 保存 / 邮件全在里面，这才是手机上该有的样子。
 *
 * <p>Android 的 {@code @JavascriptInterface} 只支持基本类型返回值，
 * 所以这里的方法全部返回 String / boolean，由页面侧包成 Promise。
 */
public class NativeBridge {

    private final MainActivity act;

    NativeBridge(MainActivity act) {
        this.act = act;
    }

    /** 分享一个文本文件（导出备份走这条） */
    @JavascriptInterface
    public String shareFile(final String name, final String content, final String label) {
        try {
            final File dir = new File(act.getCacheDir(), "share");
            if (!dir.exists() && !dir.mkdirs()) return "failed";
            final File f = new File(dir, name);
            final Uri uri = FileProvider.getUriForFile(
                    act, act.getPackageName() + ".fileprovider", f);

            // 必须回到主线程：Intent 只能从 UI 线程发起
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try (FileOutputStream out = new FileOutputStream(f);
                         OutputStreamWriter w = new OutputStreamWriter(out, StandardCharsets.UTF_8)) {
                        w.write(content);
                    } catch (Exception e) {
                        android.util.Log.e("wordbank", "写分享文件失败", e);
                        return;
                    }
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("application/json");
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.putExtra(Intent.EXTRA_SUBJECT, label);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Intent chooser = Intent.createChooser(send, label);
                    // chooser 也要给权限，否则收不到那一个 URI
                    chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    act.startActivity(chooser);
                }
            });
            return "shared";
        } catch (Exception e) {
            android.util.Log.e("wordbank", "shareFile 失败", e);
            return "failed";
        }
    }

    /** 分享纯文本 */
    @JavascriptInterface
    public boolean shareText(final String title, final String text) {
        try {
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_SUBJECT, title);
                    send.putExtra(Intent.EXTRA_TEXT, text);
                    act.startActivity(Intent.createChooser(send, title));
                }
            });
            return true;
        } catch (Exception e) {
            android.util.Log.e("wordbank", "shareText 失败", e);
            return false;
        }
    }

    /** 复制到剪贴板 —— 移动端 WebView 里 navigator.clipboard 经常因为没有
     *  用户手势或非安全上下文而失败，系统剪贴板更可靠。 */
    @JavascriptInterface
    public boolean copyText(final String text) {
        try {
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    ClipboardManager cm =
                            (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm == null) return;
                    cm.setPrimaryClip(ClipData.newPlainText("wordbank", text));
                }
            });
            return true;
        } catch (Exception e) {
            android.util.Log.e("wordbank", "copyText 失败", e);
            return false;
        }
    }

    /** 轻提示（比网页 toast 更短、更靠下，不挡内容） */
    @JavascriptInterface
    public void toast(final String msg) {
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                android.widget.Toast.makeText(act, msg, android.widget.Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * 朗读英文（单词 / 例句）。
     *
     * <p>为什么必须走原生：Android WebView 的 speechSynthesis 经常一个 voice
     * 都列不出来，speak() 静默无声 —— 不报错也不出声，比没有还糟。
     * 原生 TextToSpeech 走系统引擎，离线可用。引擎本体在 MainActivity 里，
     * 生命周期跟壳走（初始化是异步的，第一次点的那句话会被记下来补读）。
     */
    @JavascriptInterface
    public boolean speak(final String text, final float rate) {
        act.speak(text, rate);
        return true;
    }

    /** 停止当前朗读（页面销毁 / 快速连点时别让声音叠起来） */
    @JavascriptInterface
    public void stopSpeak() {
        act.stopSpeak();
    }

    /**
     * Edge TTS（微软神经语音，免 key）——合成完把 mp3 以 Base64 回调给页面
     * {@code window.__wbEdgeTts(id, status, b64)}。协议实现在 {@link EdgeTts}。
     */
    @JavascriptInterface
    public void edgeTts(final String id, final String text,
                        final String voice, final String rate) {
        EdgeTts.speak(act, id, text, voice, rate);
    }

    /**
     * 发一个 JSON POST，把结果回调给页面。
     *
     * <p>★ 为什么这一步必须由原生做（而不是页面里 fetch）：
     * WebView 里的页面虽然挂在一个 https 虚拟域名下，但它发**跨域**请求时
     * 仍然受 CORS 约束 —— 第三方 AI 接口不返回 {@code Access-Control-Allow-Origin}
     * 时，浏览器连请求都不发，页面上只会看到一个「Failed to fetch」。
     * 原生这一层没有 CORS 这个概念。
     *
     * <p>★ 为什么是「回调」而不是「返回字符串」：
     * {@code @JavascriptInterface} 只能同步返回基本类型。所以这里起线程，
     * 拿到结果后 {@code evaluateJavascript} 回调页面侧的
     * {@code window.__wbHttp(id, status, text)}。页面侧用 id 把 Promise 接回去
     * （见 src/ai/transport.ts）。status < 0 表示根本没发出去（网络/DNS）。
     *
     * <p>★ 超时给得很宽（读 120s）：AI 生成一整段 JSON 本来就要几秒到几十秒，
     * 页面上还有自己的 90s 兜底；这里再短就会把「模型有点慢」变成「失败」。
     */
    @JavascriptInterface
    public void httpPost(final String id, final String url,
                         final String headersJson, final String body) {
        final MainActivity activity = act;
        new Thread(new Runnable() {
            @Override
            public void run() {
                int status = -1;
                String text = "";
                try {
                    java.net.HttpURLConnection c =
                            (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(120000);
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    if (headersJson != null && headersJson.length() > 0) {
                        org.json.JSONObject h = new org.json.JSONObject(headersJson);
                        java.util.Iterator<String> it = h.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            c.setRequestProperty(k, h.optString(k));
                        }
                    }
                    try (java.io.OutputStream os = c.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                    status = c.getResponseCode();
                    java.io.InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    if (is != null) {
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        is.close();
                        text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
                    }
                } catch (Exception e) {
                    status = -1;
                    text = e.getClass().getSimpleName() + ": " + e.getMessage();
                    android.util.Log.e("wordbank", "httpPost 失败 " + url, e);
                }
                activity.evalJs("window.__wbHttp && window.__wbHttp("
                        + MainActivity.jsonString(id) + "," + status + ","
                        + MainActivity.jsonString(text) + ")");
            }
        }).start();
    }

    /**
     * 发一个 JSON POST，把**二进制**响应以 Base64 回调给页面。
     *
     * <p>为什么 {@link #httpPost} 不够用：它把响应按 UTF-8 文本读回来，
     * mp3 这类二进制会被解析成乱码（非法 UTF-8 序列直接丢成 U+FFFD），
     * 过不了 String 桥。这里把原始字节先 Base64（NO_WRAP）再回传，
     * 页面侧 atob 还原。回调
     * {@code window.__wbHttpBin(id, status, b64)}；status &lt; 0 时 b64
     * 是错误消息的 Base64（神经 TTS 音频走这条，见 src/ai/ttsNeural.ts）。
     */
    @JavascriptInterface
    public void httpPostBin(final String id, final String url,
                            final String headersJson, final String body) {
        final MainActivity activity = act;
        new Thread(new Runnable() {
            @Override
            public void run() {
                int status = -1;
                String b64 = "";
                try {
                    java.net.HttpURLConnection c =
                            (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(60000);
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    if (headersJson != null && headersJson.length() > 0) {
                        org.json.JSONObject h = new org.json.JSONObject(headersJson);
                        java.util.Iterator<String> it = h.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            c.setRequestProperty(k, h.optString(k));
                        }
                    }
                    try (java.io.OutputStream os = c.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                    status = c.getResponseCode();
                    java.io.InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    if (is != null) {
                        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        is.close();
                        b64 = android.util.Base64.encodeToString(bos.toByteArray(),
                                android.util.Base64.NO_WRAP);
                    }
                } catch (Exception e) {
                    status = -1;
                    String msg = e.getClass().getSimpleName() + ": " + e.getMessage();
                    b64 = android.util.Base64.encodeToString(
                            msg.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
                    android.util.Log.e("wordbank", "httpPostBin 失败 " + url, e);
                }
                activity.evalJs("window.__wbHttpBin && window.__wbHttpBin("
                        + MainActivity.jsonString(id) + "," + status + ","
                        + MainActivity.jsonString(b64) + ")");
            }
        }).start();
    }
}