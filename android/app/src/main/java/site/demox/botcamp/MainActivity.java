package site.demox.botcamp;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * BotCamp 的壳：只加载控制台（登录 + 聊天），不包含产品页和管理后台。
 * 页面本身是远端 SPA，所以网页更新后无需重新安装 APK。
 */
public class MainActivity extends Activity {
    private static final String HOST = "botcamp.demox.site";
    /** 登录接口所在的站点。授权状态存在这里的 cookie 里。 */
    private static final String API_HOST = "botcamp.aigc.sx.cn";
    /** 应用版本，控制台「关于」页显示它并据此判断有没有新版本。 */
    private static final String APP_VERSION = "2.2.0";
    /** 只进控制台；/admin/ 和产品下载页不在这个应用里。 */
    private static final String START_URL = "https://" + HOST + "/console/";
    private static final int FILE_CHOOSER = 41;
    private static final int MIC_REQUEST = 42;
    private static final int SAVE_REQUEST = 43;
    private static final int NOTIFICATION_REQUEST = 44;
    /** 系统通知渠道；聊天提醒走这一条。 */
    private static final String NOTIFICATION_CHANNEL = "botcamp-alerts";
    /** 点通知时带上的群或 bot id，进程还在就只切页面，不重载。 */
    private static final String EXTRA_GROUP_ID = "site.demox.botcamp.GROUP_ID";
    private static final String EXTRA_BOT_ID = "site.demox.botcamp.BOT_ID";
    private static final String PREF_NOTIFICATION_ASKED = "notificationAsked";
    /** bot 和群 id 都是 cuid；只接受安全字符，避免拼进地址或脚本时带进别的东西。 */
    private static final Pattern CHAT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

    private FrameLayout root;
    private WebView web;
    private ProgressBar progress;
    private LinearLayout offline;
    private ValueCallback<Uri[]> pendingFiles;
    private PermissionRequest pendingPermission;
    private String pendingDownload;
    private boolean failed;
    /**
     * 飞书登录已经离开控制台。这条链上的后续跳转都留在应用里，
     * 直到回到控制台。中途交给系统浏览器会丢掉登录状态。
     */
    private boolean oauthNavigation;
    /** 控制台首页 HTML，用作 SPA 回退（Demox 对 /console/xxx 直接返回产品页）。 */
    private byte[] indexHtml;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        createNotificationChannel();
        int barColor = Color.rgb(249, 249, 249);
        getWindow().setStatusBarColor(barColor);
        getWindow().setNavigationBarColor(barColor);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        root = new FrameLayout(this);
        root.setBackgroundColor(barColor);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(249, 249, 249));
        web.setLayoutParams(match());
        configure(web);
        root.addView(web);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        FrameLayout.LayoutParams progressParams =
                new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2));
        progressParams.gravity = Gravity.TOP;
        root.addView(progress, progressParams);

        offline = buildOffline();
        offline.setVisibility(View.GONE);
        root.addView(offline, match());

        // 全面屏 / 刘海屏留白
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top;
                int bottom;
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets bars = insets.getInsets(
                            WindowInsets.Type.statusBars()
                                    | WindowInsets.Type.navigationBars()
                                    | WindowInsets.Type.displayCutout());
                    top = bars.top;
                    bottom = bars.bottom;
                } else {
                    top = insets.getSystemWindowInsetTop();
                    bottom = insets.getSystemWindowInsetBottom();
                }
                v.setPadding(0, top, 0, bottom);
                return insets;
            }
        });

        setContentView(root);
        root.requestApplyInsets();

        // 版本变了先清掉 Service Worker 和缓存，否则 WebView 会一直用旧版的壳。
        if (!APP_VERSION.equals(getSharedPreferences("botcamp", MODE_PRIVATE)
                .getString("seenVersion", ""))) {
            getSharedPreferences("botcamp", MODE_PRIVATE).edit()
                    .putString("seenVersion", APP_VERSION).apply();
            web.clearCache(true);
            web.evaluateJavascript(
                    "if(window.navigator.serviceWorker){navigator.serviceWorker.getRegistrations()"
                            + ".then(function(rs){rs.forEach(function(r){r.unregister()})})}"
                            + "if(window.caches){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k)})})}",
                    null);
        }

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(chatUrl(chatFrom(getIntent())));
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // 点通知只切页面，保留原来打开着的聊天和输入。
        String groupId = idFrom(intent, EXTRA_GROUP_ID);
        String botId = idFrom(intent, EXTRA_BOT_ID);
        if (groupId != null || botId != null) openChat(groupId, botId);
    }

    private static String idFrom(Intent intent, String extra) {
        if (intent == null) return null;
        String id = intent.getStringExtra(extra);
        return id != null && CHAT_ID.matcher(id).matches() ? id : null;
    }

    /** 群和一对一都在控制台的 hash 路由里。 */
    private static String chatUrl(String[] chat) {
        if (chat[0] != null) return START_URL + "#/app/g/" + chat[0];
        if (chat[1] != null) return START_URL + "#/app/" + chat[1];
        return START_URL;
    }

    private static String[] chatFrom(Intent intent) {
        return new String[]{idFrom(intent, EXTRA_GROUP_ID), idFrom(intent, EXTRA_BOT_ID)};
    }

    /** 进程还在：改 hash，让已打开的控制台直接切过去。 */
    private void openChat(String groupId, String botId) {
        if (web == null || (groupId == null && botId == null)) return;
        String target = groupId != null ? "#/app/g/" + groupId : "#/app/" + botId;
        if (isConsole(web.getUrl())) {
            web.evaluateJavascript("window.location.hash='" + target + "'", null);
        } else {
            web.loadUrl(chatUrl(new String[]{groupId, botId}));
        }
    }

    private void createNotificationChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                NOTIFICATION_CHANNEL, "BotCamp 提醒", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("有人 @ 你、任务完成或需要你处理时提醒");
        manager.createNotificationChannel(channel);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("botcamp", MODE_PRIVATE);
    }

    /**
     * Android 13 起发通知要用户同意。第一次打开控制台就问一次，
     * 否则被 @ 的人永远收不到提醒；问过之后交给系统设置页。
     */
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        if (prefs().getBoolean(PREF_NOTIFICATION_ASKED, false)) return;
        prefs().edit().putBoolean(PREF_NOTIFICATION_ASKED, true).apply();
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                NOTIFICATION_REQUEST);
    }

    /** "granted" | "denied" | "default"，网页据此决定要不要提醒。 */
    private String notificationPermissionState() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return prefs().getBoolean(PREF_NOTIFICATION_ASKED, false) ? "denied" : "default";
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null && !manager.areNotificationsEnabled()) return "denied";
        return "granted";
    }

    /** 给网页用的接口。只在控制台页面响应，登录跳转页拿不到。 */
    private final class NotificationBridge {
        @JavascriptInterface
        public String notificationPermission() {
            return notificationPermissionState();
        }

        @JavascriptInterface
        public void showNotification(String title, String body, String tag, String groupId,
                                     String botId) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    postNotification(title, body, tag, groupId, botId);
                }
            });
        }
    }

    private void postNotification(String title, String body, String tag, String groupId,
                                  String botId) {
        if (web == null || !isConsole(web.getUrl())) return;
        if (!"granted".equals(notificationPermissionState())) return;
        if (title == null || title.trim().isEmpty()) return;
        String safeTitle = clip(title, 200);
        String safeBody = body == null ? "" : clip(body, 500);
        String safeGroup = groupId != null && CHAT_ID.matcher(groupId).matches() ? groupId : "";
        String safeBot = botId != null && CHAT_ID.matcher(botId).matches() ? botId : "";
        int id = (tag == null || tag.isEmpty() ? safeTitle : tag).hashCode();

        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (!safeGroup.isEmpty()) open.putExtra(EXTRA_GROUP_ID, safeGroup);
        else if (!safeBot.isEmpty()) open.putExtra(EXTRA_BOT_ID, safeBot);
        PendingIntent pending = PendingIntent.getActivity(this, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = new Notification.Builder(this, NOTIFICATION_CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setStyle(new Notification.BigTextStyle().bigText(safeBody))
                .setAutoCancel(true)
                .setContentIntent(pending);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(tag == null || tag.isEmpty() ? "botcamp" : tag, id,
                builder.build());
    }

    private static String clip(String value, int max) {
        String text = value.trim();
        return text.length() <= max ? text : text.substring(0, max);
    }

    private LinearLayout buildOffline() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.rgb(249, 249, 249));
        box.setPadding(dp(32), dp(32), dp(32), dp(32));

        TextView title = new TextView(this);
        title.setText("连接不上 BotCamp");
        title.setTextSize(18);
        title.setTextColor(Color.rgb(24, 24, 27));
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("检查网络后重试");
        hint.setTextSize(14);
        hint.setTextColor(Color.rgb(113, 113, 122));
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintParams =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT);
        hintParams.topMargin = dp(8);
        box.addView(hint, hintParams);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                failed = false;
                offline.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                web.reload();
            }
        });
        LinearLayout.LayoutParams retryParams =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT);
        retryParams.topMargin = dp(24);
        box.addView(retry, retryParams);
        return box;
    }

    private void configure(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setTextZoom(100);
        // 飞书登录页看到 WebView 标记会拒绝继续。去掉这个标记，其余标识保持系统原样。
        String agent = s.getUserAgentString();
        if (agent != null && agent.contains("; wv")) {
            s.setUserAgentString(agent.replace("; wv", ""));
        }
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, true);

        // 页面用 window.botcampAndroid 发系统通知；只有控制台页面能被响应。
        view.addJavascriptInterface(new NotificationBridge(), "botcampAndroid");

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            // 旧接口在部分 WebView 上仍会被调用，保持一致的处理。
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return handleUrl(url);
            }

            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                // 尽早注入，让「关于」拿到壳的版本而不是网页构建号。
                v.evaluateJavascript(
                        "window.__BOTCAMP_APP__={platform:'android',version:'" + APP_VERSION + "'}",
                        null);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (isConsole(url)) {
                    oauthNavigation = false;
                    askNotificationPermission();
                }
                v.evaluateJavascript(
                        "window.__BOTCAMP_APP__={platform:'android',version:'" + APP_VERSION + "'}",
                        null);
                progress.setVisibility(View.GONE);
                if (!failed) {
                    offline.setVisibility(View.GONE);
                    web.setVisibility(View.VISIBLE);
                }
            }

            /**
             * Demox 是静态托管，没有 SPA 回退：直接打开 /console/app/<id> 会拿到产品页。
             * 这里把控制台的深层路径都换成 index.html，由前端路由接管。
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                if (request == null || !request.isForMainFrame()) return null;
                Uri url = request.getUrl();
                if (url == null || !HOST.equals(url.getHost())) return null;
                String path = url.getPath() == null ? "/" : url.getPath();
                if (!path.startsWith("/console")) return null;
                int lastSlash = path.lastIndexOf('/');
                if (path.equals("/console") || path.equals("/console/") || path.lastIndexOf('.') > lastSlash) {
                    return null;
                }
                byte[] html = consoleIndex();
                if (html == null) return null;
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse("text/html", "utf-8", 200, "OK", headers,
                        new ByteArrayInputStream(html));
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                failed = true;
                progress.setVisibility(View.GONE);
                web.setVisibility(View.GONE);
                offline.setVisibility(View.VISIBLE);
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int newProgress) {
                if (newProgress >= 100) {
                    progress.setVisibility(View.GONE);
                } else {
                    progress.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public boolean onCreateWindow(WebView v, boolean dialog, boolean userGesture,
                                          android.os.Message resultMsg) {
                final WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    private boolean handed;

                    private void hand(String url) {
                        if (handed || url == null || "about:blank".equals(url)) return;
                        handed = true;
                        if (!handleUrl(url) && web != null) web.loadUrl(url);
                        popup.post(new Runnable() {
                            @Override
                            public void run() {
                                popup.destroy();
                            }
                        });
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        hand(request.getUrl().toString());
                        return true;
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, String url) {
                        hand(url);
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                        hand(url);
                    }
                });
                android.webkit.WebView.WebViewTransport transport =
                        (android.webkit.WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    pendingFiles = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                boolean wantsAudio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsAudio = true;
                }
                if (!wantsAudio) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    return;
                }
                pendingPermission = request;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_REQUEST);
            }
        });

        view.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
                if (Build.VERSION.SDK_INT < 29
                        && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
                    pendingDownload = url;
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                            SAVE_REQUEST);
                    return;
                }
                download(url, contentDisposition, mimeType);
            }
        });
    }

    /** 取一次控制台首页缓存起来；失败就交给 WebView 自己请求。 */
    private byte[] consoleIndex() {
        if (indexHtml != null) return indexHtml;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("https://" + HOST + "/console/index.html")
                    .openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            try (InputStream in = connection.getInputStream();
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                indexHtml = out.toByteArray();
            }
            return indexHtml;
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void download(String url, String contentDisposition, String mimeType) {
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            request.setMimeType(mimeType);
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            manager.enqueue(request);
            Toast.makeText(this, "开始下载：" + name, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "下载失败", Toast.LENGTH_SHORT).show();
        }
    }

    /** 控制台，以及进行中的飞书登录，留在应用里。其余链接交给系统浏览器。 */
    private boolean handleUrl(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if ("intent".equals(scheme)) return handleIntent(url);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
        if (isConsole(url)) {
            oauthNavigation = false;
            return false;
        }
        if (oauthNavigation || directoryAuthorize(uri)) {
            oauthNavigation = true;
            CookieManager.getInstance().flush();
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
        }
        return true;
    }

    /** 登录页用 intent 唤起飞书客户端时，改走它自带的网页地址，避免跳出应用。 */
    private boolean handleIntent(String url) {
        if (!oauthNavigation) return false;
        String fallback = intentFallback(url);
        if (fallback != null && (fallback.startsWith("https://") || fallback.startsWith("http://"))) {
            final String next = fallback;
            web.post(new Runnable() {
                @Override
                public void run() {
                    if (web != null) web.loadUrl(next);
                }
            });
        }
        return true;
    }

    private static String intentFallback(String url) {
        String key = "S.browser_fallback_url=";
        int marker = url.indexOf(key);
        if (marker < 0) return null;
        String rest = url.substring(marker + key.length());
        int end = rest.indexOf(';');
        if (end >= 0) rest = rest.substring(0, end);
        try {
            return URLDecoder.decode(rest, "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isConsole(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        String host = uri.getHost() == null ? "" : uri.getHost();
        String path = uri.getPath() == null ? "/" : uri.getPath();
        return HOST.equals(host) && path.startsWith("/console");
    }

    /** 目录登录的第一跳：接口上的授权，或飞书 / Lark 的账号页。 */
    private static boolean directoryAuthorize(Uri uri) {
        String host = uri.getHost() == null ? "" : uri.getHost();
        String path = uri.getPath() == null ? "/" : uri.getPath();
        if (API_HOST.equals(host) && path.startsWith("/api/auth")) return true;
        if (authHost(host, "feishu.cn") || authHost(host, "larksuite.com") || authHost(host, "larkoffice.com")) {
            return path.startsWith("/open-apis/authen")
                    || path.startsWith("/accounts")
                    || path.startsWith("/oauth")
                    || path.startsWith("/suite/passport")
                    || path.startsWith("/login");
        }
        return false;
    }

    private static boolean authHost(String host, String domain) {
        return host.equals("accounts." + domain)
                || host.equals("passport." + domain)
                || host.equals("login." + domain)
                || host.equals("open." + domain);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == MIC_REQUEST) {
            if (pendingPermission != null) {
                if (granted) {
                    pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    pendingPermission.deny();
                }
                pendingPermission = null;
            }
            return;
        }
        if (code == SAVE_REQUEST && pendingDownload != null) {
            if (granted) download(pendingDownload, null, null);
            else Toast.makeText(this, "没有存储权限，无法保存文件", Toast.LENGTH_SHORT).show();
            pendingDownload = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER || pendingFiles == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        pendingFiles.onReceiveValue(result);
        pendingFiles = null;
    }

    @Override
    public void onBackPressed() {
        if (offline.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
            return;
        }
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
