package com.rhecyee.efunny.core.net

/**
 * Serves canned responses so feeler parsing is tested against captured payloads
 * with no server, no ports and no network flake.
 *
 * [routes] matches on a URL substring, so a test can script a multi-call feeler
 * (Reddit's token-then-listing, YouTube's search-then-videos) without caring
 * about query-parameter ordering.
 */
class FakeHttp(
    private val body: String = "",
    private val code: Int = 200,
    private val routes: List<Pair<String, HttpResponse>> = emptyList(),
    private val failWith: HttpFailure? = null,
) : Http {

    val requestedUrls = mutableListOf<String>()
    val sentHeaders = mutableListOf<Map<String, String>>()
    val sentForms = mutableListOf<Map<String, String>>()

    override suspend fun get(url: String, headers: Map<String, String>): HttpResponse {
        requestedUrls += url
        sentHeaders += headers
        failWith?.let { throw it }
        return routes.firstOrNull { url.contains(it.first) }?.second ?: HttpResponse(code, body)
    }

    override suspend fun postForm(
        url: String,
        form: Map<String, String>,
        headers: Map<String, String>,
    ): HttpResponse {
        requestedUrls += url
        sentHeaders += headers
        sentForms += form
        failWith?.let { throw it }
        return routes.firstOrNull { url.contains(it.first) }?.second ?: HttpResponse(code, body)
    }
}
