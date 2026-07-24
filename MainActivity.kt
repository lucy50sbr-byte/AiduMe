package com.example.aidumetv

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private val targetUrl = "https://lucy50sbr-byte.github.io/AiduMe/?tv=1"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val rootLayout = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        webView = WebView(this).apply {
            isFocusable = true
            isFocusableInTouchMode = true

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                loadWithOverviewMode = true
                useWideViewPort = true

                // 💡 HABILITAR CACHE INTERNO DE ANDROID PARA ACCESO SIN CONEXIÓN
                cacheMode = WebSettings.LOAD_DEFAULT

                userAgentString = userAgentString + " AiduMeTV"
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            }

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                    view.loadUrl(url)
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    progressBar.visibility = View.GONE
                }

                // SI FALLA LA CONEXIÓN (ANTES O DURANTE LA CARGA), MOSTRAR PANTALLA LOCAL
                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError
                ) {
                    if (request.isForMainFrame) {
                        progressBar.visibility = View.GONE
                        mostrarPantallaOfflineLocal(view)
                    }
                }
            }

            webChromeClient = WebChromeClient()
        }

        progressBar = ProgressBar(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = android.view.Gravity.CENTER
            }
            visibility = View.VISIBLE
        }

        rootLayout.addView(webView)
        rootLayout.addView(progressBar)
        setContentView(rootLayout)

        // 💡 VERIFICACIÓN PREVIA DE RED: Si no hay conexión al abrir la app, cargar pantalla local directamente
        if (hayConexionInternet(this)) {
            webView.loadUrl(targetUrl)
        } else {
            progressBar.visibility = View.GONE
            mostrarPantallaOfflineLocal(webView)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    // Comprueba si el dispositivo tiene acceso a red antes de cargar la URL
    private fun hayConexionInternet(context: Context): Boolean {
        val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = connectivityManager.activeNetwork ?: return false
        val activeNetwork = connectivityManager.getNetworkCapabilities(network) ?: return false
        return when {
            activeNetwork.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> true
            activeNetwork.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> true
            activeNetwork.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> true
            else -> false
        }
    }

    // Carga la plantilla local estilizada que nunca depende de internet
    private fun mostrarPantallaOfflineLocal(view: WebView) {
        val offlineHtml = """
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>AiduMe - Sin conexión</title>
                <style>
                    body {
                        background-color: #0b0b0b;
                        color: #ffffff;
                        font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        margin: 0;
                        padding: 20px;
                        box-sizing: border-box;
                    }
                    .card {
                        background: #141414;
                        border: 2px solid #ffd700;
                        border-radius: 20px;
                        padding: 40px 30px;
                        max-width: 450px;
                        width: 90%;
                        text-align: center;
                        box-shadow: 0 0 30px rgba(255, 215, 0, 0.15);
                    }
                    .icon { font-size: 3.5rem; margin-bottom: 10px; }
                    h1 { color: #ffd700; font-size: 1.5rem; margin-bottom: 10px; font-weight: 900; letter-spacing: 1px; }
                    p { color: #aaaaaa; font-size: 0.9rem; line-height: 1.5; margin-bottom: 25px; }
                    .btn-retry {
                        background: linear-gradient(135deg, #ffd700, #ffaa00);
                        color: #000000;
                        border: none;
                        padding: 14px 28px;
                        font-size: 1rem;
                        font-weight: bold;
                        border-radius: 30px;
                        cursor: pointer;
                        outline: none;
                        transition: all 0.3s ease;
                    }
                    .btn-retry:focus, .btn-retry:hover {
                        transform: scale(1.08);
                        box-shadow: 0 0 20px rgba(255, 215, 0, 0.6);
                        outline: 3px solid #ffffff !important;
                    }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">📡</div>
                    <h1>SIN CONEXIÓN A INTERNET</h1>
                    <p>No se pudo conectar a AiduMe. Comprueba tu conexión Wi-Fi o Ethernet en la TV e intenta nuevamente.</p>
                    <button class="btn-retry" tabindex="0" onclick="window.location.href='$targetUrl'">🔄 REINTENTAR CONEXIÓN</button>
                </div>
            </body>
            </html>
        """.trimIndent()

        view.loadDataWithBaseURL(null, offlineHtml, "text/html", "UTF-8", null)
    }
}