package com.wordbank.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Arrays;
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
 * <p>协议要点（对照 python edge-tts 7.3.1 逐字核对过）：
 * <ul>
 *   <li>Sec-MS-GEC 是 **v2 算法**（CS64 + 变形 SHA-256 组合，见下方常量区），
 *       2026 年起 v1（纯 SHA-256）已被服务端拒绝（403）；ticks 走 float64 ——
 *       先 +11644473600、按 300 秒向下取整、再 *1e7，乘完后数值超过 double
 *       精度会舍入到 16 的倍数，服务端按同样的 float64 行为校验；</li>
 *   <li>URL 参数顺序 ConnectionId → Sec-MS-GEC → Sec-MS-GEC-Version；
 *       请求头带新扩展 Origin 与 Cookie muid；</li>
 *   <li>先发 speech.config 文本帧（JSON 后带 \r\n），再发 SSML 文本帧
 *       （Path:ssml，X-Timestamp 带 Z 后缀）；</li>
 *   <li>二进制帧开头 2 字节大端头长，头里有 {@code Path:audio} 的，
 *       剩余字节是 mp3；</li>
 *   <li>文本帧出现 {@code Path:turn.end} 即合成完毕。</li>
 * </ul>
 *
 * <p>Sec-MS-GEC v2 算法已用 edge-tts 库生成的 4 个黄金向量逐字符对拍通过
 * （固定时间戳 1700000000 / 1768900000 / 1768900300 / 1768956000.7）。
 *
 * <p>这是非公开接口，微软随时可能改 —— 失败时页面侧会静默掉到下一级
 * （硅基流动 / 系统 TTS），不会让用户点个喇叭就看见报错。
 */
final class EdgeTts {

    private static final String TRUSTED = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final String GEC_VERSION = "2-143.0.3650.75";
    private static final String WSS_URL =
            "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
                    + "?TrustedClientToken=" + TRUSTED;
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    + " (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
                    + " Edg/143.0.0.0";
    private static final String ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

    // ---- Sec-MS-GEC v2 算法常量（drm.py 逐字抄，int 即 mod 2^32） ----
    private static final int[] SHA256_INITIAL = {
            0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
            0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19 };
    private static final int[] SHA256_STATE = {
            0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
            0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2 };
    private static final int[] SHA256_SCHEDULE = {
            0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
            0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
            0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
            0xD258B060, 0x72766564 };
    private static final int[] K = {
            0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
            0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
            0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
            0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
            0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
            0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
            0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
            0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2 };
    private static final int SHA256_ADJUSTMENT = 0xC9DC06A7;
    private static final int SIGMA0_ADJUSTMENT = 0x059C0B80;
    private static final int SIGMA1_ADJUSTMENT = 0x000B92C0;
    private static final int[][] CS64_COEFFS = {
            {0xE82E91B1, 0xB32700D0}, {0x44DE24C6, 0x88DFF51D},
            {0x3BEB65BC, 0x29514038}, {0xC89C5933, 0xB328CBDF},
            {0x8D1EC211, 0xD405B4D5}, {0x314EF5D5, 0x26E55F3C},
            {0xE92491B1, 0x607801C6}, {0xF0A5B9D5, 0x82B2C1FB},
            {0x06064CF3, 0xFA51A3DA}, {0xDA79FA60, 0x207CC464},
            {0xBED20560, 0x3C3C74F3}, {0x89F9C9F8, 0xD2D14B61},
            {0x35FA38C6, 0xBB04A2C1}, {0xCB49E3C6, 0xC5626167} };
    private static final int CS64_FACTOR = 0x82893933;
    private static final int CS64_ADJUSTMENT0 = 0xF2F90B1A;
    private static final int CS64_ADJUSTMENT1 = 0x0B1A0000;

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
                    String url = WSS_URL
                            + "&ConnectionId=" + UUID.randomUUID().toString().replace("-", "")
                            + "&Sec-MS-GEC=" + secMsGecV2()
                            + "&Sec-MS-GEC-Version=" + GEC_VERSION;
                    Request req = new Request.Builder()
                            .url(url)
                            .header("Pragma", "no-cache")
                            .header("Cache-Control", "no-cache")
                            .header("Origin", ORIGIN)
                            .header("User-Agent", UA)
                            .header("Accept-Encoding", "gzip, deflate, br, zstd")
                            .header("Accept-Language", "en-US,en;q=0.9")
                            .header("Cookie", "muid=" + muid() + ";")
                            .build();
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

    // ---- Sec-MS-GEC v2（drm.py 移植，黄金向量 4/4 对拍通过） ----

    /** int 运算天然 mod 2^32 ≡ Python 的 & mask；v2 的 sigma 先异或后截断，等价。 */
    private static int rol16(int v) { return Integer.rotateLeft(v, 16); }

    private static int sigma0(int v) {
        return (v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3);
    }

    private static int sigma1(int v) {
        return (v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10);
    }

    private static void expandSchedule(int[] words, int first) {
        for (int index = first; index < 64; index++) {
            int x = words[index - 2], y = words[index - 15];
            int s1 = (x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10);
            int s0 = (y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3);
            words[index] = s1 + words[index - 7] + s0 + words[index - 16];
        }
    }

    /** 轮函数。drm.py 的双循环是寄存器轮换展开优化，语义与标准轮函数一致。 */
    private static int[] rounds(int[] state, int[] words, int firstRound, boolean blockK) {
        int a = state[0], b = state[1], c = state[2], d = state[3];
        int e = state[4], f = state[5], g = state[6], h = state[7];
        for (int i = firstRound; i < 64; i++) {
            int k = (blockK && i == 14) ? SHA256_ADJUSTMENT : K[i];
            int t1 = h
                    + (Integer.rotateRight(e, 6) ^ Integer.rotateRight(e, 11) ^ Integer.rotateRight(e, 25))
                    + (g ^ (e & (f ^ g)))
                    + k + words[i];
            int t2 = (Integer.rotateRight(a, 2) ^ Integer.rotateRight(a, 13) ^ Integer.rotateRight(a, 22))
                    + ((a & b) | (c & (a | b)));
            h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        return new int[]{a, b, c, d, e, f, g, h};
    }

    /** data 恒为 7 字节（ticks 字符串切片），按 drm.py 语义实现。 */
    private static int[] sha256Init(byte[] d) {
        int[] words = new int[64];
        words[14] = ((d[0] & 0xFF) << 16) | ((d[1] & 0xFF) << 8) | (d[2] & 0xFF);
        words[15] = ((d[3] & 0xFF) << 24) | ((d[4] & 0xFF) << 16)
                | ((d[5] & 0xFF) << 8) | (d[6] & 0xFF);
        for (int index = 16; index < 30; index++) {
            int value = SHA256_SCHEDULE[index - 16];
            value += (index == 16)
                    ? (sigma1(words[index - 2]) ^ SIGMA1_ADJUSTMENT)
                    : sigma1(words[index - 2]);
            if (index - 7 >= 14) value += words[index - 7];
            if (index == 29) value += sigma0(words[index - 15]) ^ SIGMA0_ADJUSTMENT;
            words[index] = value;
        }
        words[30] = sigma1(words[28]) + words[23] + sigma0(words[15])
                + words[14] + SHA256_ADJUSTMENT - K[14];
        expandSchedule(words, 31);
        int[] working = rounds(SHA256_STATE, words, 14, true);
        int[] out = new int[8];
        for (int i = 0; i < 8; i++) out[i] = SHA256_INITIAL[i] + working[i];
        return out;
    }

    private static byte[] sha256Digest(byte[] data) {
        int length = 57 + data.length;
        int padZeros = ((55 - length) % 64 + 64) % 64;
        int total = (data.length - 7) + 1 + padZeros + 8;
        byte[] padded = new byte[total];
        System.arraycopy(data, 7, padded, 0, data.length - 7);
        int p = data.length - 7;
        padded[p++] = (byte) 0x80;
        p += padZeros;
        long bits = (long) length * 8;
        for (int i = 0; i < 8; i++) padded[p++] = (byte) (bits >>> (56 - 8 * i));

        int[] state = sha256Init(Arrays.copyOfRange(data, 0, 7));
        for (int off = 0; off < total; off += 64) {
            int[] words = new int[64];
            for (int j = 0; j < 16; j++) {
                int o = off + j * 4;
                words[j] = ((padded[o] & 0xFF) << 24) | ((padded[o + 1] & 0xFF) << 16)
                        | ((padded[o + 2] & 0xFF) << 8) | (padded[o + 3] & 0xFF);
            }
            expandSchedule(words, 16);
            int[] working = rounds(state, words, 0, false);
            for (int i = 0; i < 8; i++) state[i] += working[i];
        }
        byte[] out = new byte[32];
        for (int i = 0; i < 8; i++) {
            out[i * 4] = (byte) (state[i] >>> 24);
            out[i * 4 + 1] = (byte) (state[i] >>> 16);
            out[i * 4 + 2] = (byte) (state[i] >>> 8);
            out[i * 4 + 3] = (byte) state[i];
        }
        return out;
    }

    private static int[] cs64Digest(byte[] data, byte[] digest) {
        int keyA = le32(digest, 0) | 1;
        int keyB = le32(digest, 4) | 1;
        int f0 = keyA * CS64_FACTOR;
        int f1 = keyB * CS64_FACTOR;

        // b"\x00" + data，补齐到 4 的倍数，词数为偶数（不足补 0）
        int rawLen = 1 + data.length;
        int paddedLen = rawLen + ((-rawLen) % 4 + 4) % 4;
        int wc = paddedLen / 4;
        if (wc % 2 != 0) wc++;

        int[] terms = new int[CS64_COEFFS.length + wc];
        int[] offsets = new int[CS64_COEFFS.length + wc];
        for (int i = 0; i < CS64_COEFFS.length; i++) {
            terms[i] = CS64_COEFFS[i][0] * ((i % 2 == 0) ? f0 : f1);
            offsets[i] = CS64_COEFFS[i][1];
        }

        byte[] padded = new byte[paddedLen];
        System.arraycopy(data, 0, padded, 1, data.length);
        int t = CS64_COEFFS.length;
        for (int index = 0; index < wc; index++) {
            int o = index * 4;
            int word = (o < paddedLen ? padded[o] & 0xFF : 0)
                    | (o + 1 < paddedLen ? (padded[o + 1] & 0xFF) << 8 : 0)
                    | (o + 2 < paddedLen ? (padded[o + 2] & 0xFF) << 16 : 0)
                    | (o + 3 < paddedLen ? (padded[o + 3] & 0xFF) << 24 : 0);
            int term = word * ((index % 2 == 0) ? keyA : keyB);
            int offset = rol16(word) * ((index % 2 == 0) ? 0xEF0569FB : 0xC31713DB);
            if (index == 0) {
                term += CS64_ADJUSTMENT0 * f0;
                offset += CS64_ADJUSTMENT1;
            }
            terms[t] = term;
            offsets[t] = offset;
            t++;
        }

        int swapAcc = 0, swapLast = 0, state = 0, acc = 0;
        for (int index = 0; index < terms.length; index += 2) {
            int x = terms[index], y = terms[index + 1];
            int tt = rol16(offsets[index] + x);
            int q = tt * 0x76F50F34;
            swapAcc += rol16(q) * 0xC3EFEA97 + q;
            tt = rol16(offsets[index + 1] + y);
            q = tt * 0x1881CE3C;
            swapLast = rol16(q) * 0x35BD1EC9 + q;
            swapAcc += swapLast;

            state = state * keyA + x;
            state = rol16(state) * 0xCF98B111;
            state = rol16(state) * 0x87085B9F;
            state = rol16(state) * 0x12CEB96D;
            state = rol16(state) * 0x257E1D83;
            acc += state;
            tt = state * keyB + y;
            tt = rol16(tt) * 0xA27416F5;
            tt = rol16(tt) * 0xD38396FF;
            state = rol16(rol16(tt) * 0x7C932B89) * 0xBFA49F69;
            acc += state;
        }
        return new int[]{swapLast ^ state, swapAcc ^ acc};
    }

    private static int le32(byte[] b, int off) {
        return (b[off] & 0xFF) | (b[off + 1] & 0xFF) << 8
                | (b[off + 2] & 0xFF) << 16 | (b[off + 3] & 0xFF) << 24;
    }

    /** v2 token：float64 全程与 Python 一致（%.0f 输出恰为整数，无舍入分歧）。 */
    private static String secMsGecV2() {
        double ticks = System.currentTimeMillis() / 1000.0;
        ticks += 11644473600.0;
        ticks -= ticks % 300.0;
        ticks *= 1e9 / 100.0;
        String s = String.format(Locale.ROOT, "%.0f", ticks);
        byte[] data = (s + TRUSTED).getBytes(StandardCharsets.US_ASCII);

        byte[] digest = sha256Digest(data);
        int[] cs = cs64Digest(data, digest);
        byte[] csb = new byte[8];
        for (int i = 0; i < 4; i++) {
            csb[i] = (byte) (cs[0] >>> (8 * i));
            csb[4 + i] = (byte) (cs[1] >>> (8 * i));
        }
        return hexUpper(csb) + "-" + hexUpper(digest);
    }

    private static String hexUpper(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02X", x));
        return sb.toString();
    }

    /** DRM.generate_muid：32 位大写 hex。 */
    private static String muid() {
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        return hexUpper(b);
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
                + "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n";
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
