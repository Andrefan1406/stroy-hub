package kz.vkdev.transport;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;

// Один экран — сайт в WebView. Страницы своего сайта открываются внутри
// приложения; всё остальное (Telegram, звонок водителю, карты) — во внешних
// приложениях телефона. «Назад» листает историю страниц, а не закрывает
// приложение сразу. Нет сети — экран «Нет соединения» с кнопкой повтора.
public class MainActivity extends Activity {
    private static final String START_URL = BuildConfig.START_URL;
    private static final String SITE_HOST = Uri.parse(START_URL).getHost();

    private WebView web;
    private View errorView;
    private ProgressBar progress;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        web = findViewById(R.id.web);
        errorView = findViewById(R.id.error);
        progress = findViewById(R.id.progress);
        Button retry = findViewById(R.id.retry);
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            web.reload();
        });

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // вход Firebase хранится в IndexedDB/localStorage
        settings.setDatabaseEnabled(true);
        settings.setSupportMultipleWindows(false); // target="_blank" — в этом же окне (или наружу, см. ниже)
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (SITE_HOST.equalsIgnoreCase(uri.getHost())) return false;
                openExternally(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) errorView.setVisibility(View.VISIBLE);
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    private void openExternally(Uri uri) {
        Intent intent = "tel".equals(uri.getScheme()) ? new Intent(Intent.ACTION_DIAL, uri) : new Intent(Intent.ACTION_VIEW, uri);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException ignored) {
            // нечем открыть — ничего не делаем
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
