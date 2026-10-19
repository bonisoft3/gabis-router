package uk.gbrouter.app;

import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {
    private static final String BROUTER_SEGMENTS_BASE = "https://brouter.de/brouter/segments4/";

    public class AndroidNativeBridge {
        @JavascriptInterface
        public boolean exportGpx(String gpxContent, String filename) {
            try {
                String safeName = (filename == null || filename.trim().isEmpty())
                        ? "route.gpx"
                        : filename.replaceAll("[^a-zA-Z0-9._\\- ]", "_");
                if (!safeName.toLowerCase().endsWith(".gpx")) {
                    safeName = safeName + ".gpx";
                }
                byte[] bytes = gpxContent.getBytes(StandardCharsets.UTF_8);

                // 1. Save a copy to the device's public Downloads folder on Android 10+
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    try {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                        values.put(MediaStore.Downloads.MIME_TYPE, "application/gpx+xml");
                        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                        Uri itemUri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (itemUri != null) {
                            try (OutputStream os = getContentResolver().openOutputStream(itemUri)) {
                                if (os != null) {
                                    os.write(bytes);
                                }
                            }
                        }
                    } catch (Exception ignored) {
                        // Fall through to share sheet even if MediaStore insert fails
                    }
                }

                // 2. Write to cache and open the native Android share/open sheet via FileProvider
                File cacheFile = new File(getCacheDir(), safeName);
                try (FileOutputStream fos = new FileOutputStream(cacheFile)) {
                    fos.write(bytes);
                }
                Uri contentUri = FileProvider.getUriForFile(
                        MainActivity.this,
                        getPackageName() + ".fileprovider",
                        cacheFile
                );

                final String finalName = safeName;
                runOnUiThread(() -> {
                    Intent shareIntent = new Intent(Intent.ACTION_SEND);
                    shareIntent.setType("application/gpx+xml");
                    shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                    shareIntent.putExtra(Intent.EXTRA_SUBJECT, finalName);
                    shareIntent.setClipData(ClipData.newRawUri(finalName, contentUri));
                    shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(shareIntent, finalName));
                });
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean shareText(String title, String text) {
            try {
                runOnUiThread(() -> {
                    Intent sendIntent = new Intent(Intent.ACTION_SEND);
                    sendIntent.setType("text/plain");
                    if (title != null && !title.isEmpty()) {
                        sendIntent.putExtra(Intent.EXTRA_SUBJECT, title);
                    }
                    sendIntent.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(sendIntent, title != null ? title : "Share route"));
                });
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (this.bridge != null) {
            if (this.bridge.getWebView() != null) {
                this.bridge.getWebView().addJavascriptInterface(new AndroidNativeBridge(), "AndroidNative");
            }

            this.bridge.setWebViewClient(new BridgeWebViewClient(this.bridge) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if (uri != null
                            && "localhost".equals(uri.getHost())
                            && uri.getPath() != null
                            && uri.getPath().startsWith("/segments4/")
                            && uri.getPath().endsWith(".rd5")) {
                        String fileName = uri.getLastPathSegment();
                        if (fileName != null && fileName.matches("^[A-Za-z0-9_]+\\.rd5$")) {
                            try {
                                URL upstream = new URL(BROUTER_SEGMENTS_BASE + fileName);
                                HttpURLConnection conn = (HttpURLConnection) upstream.openConnection();
                                conn.setRequestMethod("GET");
                                conn.setConnectTimeout(15000);
                                conn.setReadTimeout(60000);
                                conn.connect();

                                int status = conn.getResponseCode();
                                InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                                Map<String, String> headers = new HashMap<>();
                                headers.put("Access-Control-Allow-Origin", "*");
                                String contentLength = conn.getHeaderField("Content-Length");
                                if (contentLength != null) {
                                    headers.put("Content-Length", contentLength);
                                }
                                String lastModified = conn.getHeaderField("Last-Modified");
                                if (lastModified != null) {
                                    headers.put("Last-Modified", lastModified);
                                }
                                return new WebResourceResponse(
                                        "application/octet-stream",
                                        null,
                                        status,
                                        conn.getResponseMessage() != null ? conn.getResponseMessage() : "OK",
                                        headers,
                                        stream
                                );
                            } catch (Exception e) {
                                return new WebResourceResponse("text/plain", "UTF-8", 502, "Bad Gateway", null, null);
                            }
                        }
                    }
                    return super.shouldInterceptRequest(view, request);
                }
            });
        }
    }
}
