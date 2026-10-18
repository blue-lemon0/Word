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
}