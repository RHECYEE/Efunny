package com.rhecyee.efunny.core.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

data class HttpResponse(val code: Int, val body: String) {
    val isSuccess: Boolean get() = code in 200..299
}

/**
 * The one seam between feelers and the network.
 *
 * Feelers depend on this rather than OkHttp directly, so every parser can be
 * tested against a captured response with no server, no ports and no flake.
 */
interface Http {
    suspend fun get(url: String, headers: Map<String, String> = emptyMap()): HttpResponse

    suspend fun postForm(
        url: String,
        form: Map<String, String>,
        headers: Map<String, String> = emptyMap(),
    ): HttpResponse
}

/** Thrown for transport failures; feelers turn these into `Unavailable`. */
class HttpFailure(message: String, cause: Throwable? = null) : IOException(message, cause)

class OkHttpClientHttp(
    private val client: OkHttpClient = defaultClient(),
    private val userAgent: String = DEFAULT_USER_AGENT,
) : Http {

    override suspend fun get(url: String, headers: Map<String, String>): HttpResponse =
        execute(Request.Builder().url(url).get(), headers)

    override suspend fun postForm(
        url: String,
        form: Map<String, String>,
        headers: Map<String, String>,
    ): HttpResponse {
        val body = FormBody.Builder().apply { form.forEach { (k, v) -> add(k, v) } }.build()
        return execute(Request.Builder().url(url).post(body), headers)
    }

    private suspend fun execute(
        builder: Request.Builder,
        headers: Map<String, String>,
    ): HttpResponse = withContext(Dispatchers.IO) {
        builder.header("User-Agent", userAgent)
        headers.forEach { (k, v) -> builder.header(k, v) }
        try {
            client.newCall(builder.build()).execute().use { response ->
                HttpResponse(response.code, response.body?.string().orEmpty())
            }
        } catch (e: IOException) {
            throw HttpFailure("Request failed: ${e.message}", e)
        }
    }

    companion object {
        /**
         * Reddit rejects generic and empty user agents outright, and asks that
         * clients identify themselves. Everything else is happy with this too.
         */
        const val DEFAULT_USER_AGENT = "android:com.rhecyee.efunny:0.1.0 (by /u/efunny_app)"

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
