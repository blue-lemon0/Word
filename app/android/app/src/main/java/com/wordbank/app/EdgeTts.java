package com.wordbank.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Edge TTS —— 微软 Edge「大声朗读」背后的在线神经语音，**免 key、免费**。
 * （explore/tts 探索分支）
 *
 * <p>为什么网页里连不上、原生却可以：服务端校验 Origin，浏览器发 WebSocket
 * 必须带 Origin 且伪造不了；原生客户端根本不发这个头。TLS 指纹拦截也只
 * 针对特定客户端（实测 Node 的握手被重置，浏览器与系统级客户端都通）。
 *
 * <p>协议要点（python edge-tts 等开源实现里反复验证过）：
 * <ul>
 *   <li>URL 带 TrustedClientToken + Sec-MS-GEC（Windows 纪元秒向下取整到
 *       300 秒，拼上 token 后 SHA-256 大写 hex）+ Sec-MS-GEC-Version；</li>
 *   <li>先发 speech.config 文本帧，再发 SSML 文本帧（Path:ssml）；</li>
 *   <li>二进制帧开头 2 字节大端头长，头里有 {@code Path:audio} 的，
 *       剩余字节是 mp3；</li>
 *   <li>文本帧出现 {@code Path:turn.end} 即合成完毕。</li>
 * </ul>
 *
 * <p>这是非公开接口，微软随时可能改 —— 失败时页面侧会静默掉到下一级
 * （硅基流动 / 系统 TTS），不会让用户点个喇叭就看见报错。
 */
final class EdgeTts {

    private static final String TRUSTED = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final String GEC_VERSION = "1-130.0.2849.68";
    private static final String WS_URL =
            "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
                    + "?TrustedClientToken=" + TRUSTED + "&Sec-MS-GEC-Version=" + GEC_VERSION;

    private EdgeTts() {}

    /** NativeBridge.edgeTts 转到这里：合成完把 mp3 Base64 回调给页面。 */
    static void speak(final MainActivity act, final String id, final String text,
                      final String voice, final String rate) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                final ByteArrayOutputStream audio = new ByteArrayOutputStream();
                final AtomicReference<String> err = new AtomicReference<>(null);
                final CountDownLatch latch = new CountDownLatch(1);
                WebSocket ws = null;
                try {
                    OkHttpClient client = new OkHttpClient.Builder()
                            .connectTimeout(15, TimeUnit.SECONDS)
                            .readTimeout(25, TimeUnit.SECONDS)
                            .build();
                    Request req = new Request.Builder()
                            .url(WS_URL + "&Sec-MS-GEC=" + secMsGec()).build();
                    ws = client.newWebSocket(req, new WebSocketListener() {
                        @Override
                        public void onOpen(WebSocket w, Response response) {
                            String ts = timestamp();
                            w.send(speechConfig(ts));
                            w.send(ssmlMessage(ts, text, voice, rate));
                        }

                        @Override
                        public void onMessage(WebSocket w, String txt) {
                            if (txt.contains("Path:turn.end")) {
                                w.close(1000, null);
                                latch.countDown();
                            }
                        }

                        @Override
                        public void onMessage(WebSocket w, ByteString bytes) {
                            byte[] b = bytes.toByteArray();
                            if (b.length < 2) return;
                            int headLen = ((b[0] & 0xFF) << 8) | (b[1] & 0xFF);
                            if (b.length < 2 + headLen) return;
                            String head = new String(b, 2, headLen, StandardCharsets.US_ASCII);
                            if (head.contains("Path:audio")) {
                                audio.write(b, 2 + headLen, b.length - 2 - headLen);
                            }
                        }

                        @Override
                        public void onFailure(WebSocket w, Throwable t, Response response) {
                            err.compareAndSet(null,
                                    t.getClass().getSimpleName() + ": " + t.getMessage());
                            latch.countDown();
                        }
                    });
                    if (!latch.await(30, TimeUnit.SECONDS)) {
                        err.compareAndSet(null, "超时");
                    }
                } catch (Exception e) {
                    err.compareAndSet(null, e.getClass().getSimpleName() + ": " + e.getMessage());
                }
                if (ws != null) ws.cancel();

                int status;
                String b64;
                if (err.get() == null && audio.size() > 0) {
                    status = 200;
                    b64 = android.util.Base64.encodeToString(
                            audio.toByteArray(), android.util.Base64.NO_WRAP);
                } else {
                    status = -1;
                    String msg = err.get() != null ? err.get() : "无音频";
                    android.util.Log.e("wordbank", "edgeTts 失败: " + msg);
                    b64 = android.util.Base64.encodeToString(
                            msg.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
                }
                act.evalJs("window.__wbEdgeTts && window.__wbEdgeTts("
                        + MainActivity.jsonString(id) + "," + status + ","
                        + MainActivity.jsonString(b64) + ")");
            }
        }).start();
    }

    /** Sec-MS-GEC：Windows 纪元（1601）秒向下取整到 300 秒，拼 token 后 SHA-256。 */
    private static String secMsGec() throws Exception {
        long secs = System.currentTimeMillis() / 1000 + 11644473600L;
        secs -= secs % 300;
        byte[] d = MessageDigest.getInstance("SHA-256")
                .digest((secs + TRUSTED).getBytes(StandardCharsets.US_ASCII));
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) sb.append(String.format("%02X", b));
        return sb.toString();
    }

    /** Edge 协议的时间戳格式（UTC，带时区字样）。 */
    private static String timestamp() {
        SimpleDateFormat f = new SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date()) + " GMT+0000 (Coordinated Universal Time)";
    }

    private static String speechConfig(String ts) {
        return "X-Timestamp:" + ts + "\r\n"
                + "Content-Type:application/json; charset=utf-8\r\n"
                + "Path:speech.config\r\n\r\n"
                + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
                + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},"
                + "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
    }

    private static String ssmlMessage(String ts, String text, String voice, String rate) {
        return "X-RequestId:" + UUID.randomUUID().toString().replace("-", "") + "\r\n"
                + "Content-Type:application/ssml+xml\r\n"
                + "X-Timestamp:" + ts + "Z\r\n"
                + "Path:ssml\r\n\r\n"
                + "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
                + "<voice name='" + voice + "'>"
                + "<prosody pitch='+0Hz' rate='" + rate + "' volume='+0%'>"
                + escape(text)
                + "</prosody></voice></speak>";
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }
}
