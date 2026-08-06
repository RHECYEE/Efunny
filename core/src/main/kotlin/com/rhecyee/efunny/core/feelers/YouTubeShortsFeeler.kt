package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.RawPost
import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import com.rhecyee.efunny.core.net.Http
import com.rhecyee.efunny.core.net.HttpFailure
import com.rhecyee.efunny.core.spotlight.SpotlightSpec
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URLEncoder
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * Trending YouTube Shorts from the last 24 hours.
 *
 * Two API facts drive the shape of this class:
 *
 * 1. `chart=mostPopular` is deliberately **not** used. Since 21 Jul 2025 it
 *    returns the Trending Music, Movies and Gaming charts -- not short-form
 *    comedy. `search.list` with a publish window is the only route to genuinely
 *    recent Shorts.
 * 2. `search.list` is metered in its own "Search Queries" bucket capped at 100
 *    calls/day, separate from the 10,000-unit standard quota that `videos.list`
 *    draws on. Three drops a day with one seed query is 3 calls, but every extra
 *    configured query multiplies by three -- so the call is gated behind
 *    [SearchBudget] rather than trusted to stay small.
 *
 * There is no official "is a Short" flag, so duration is the filter:
 * `videoDuration=short` only narrows to under four minutes, while a Short is at
 * most three. The second call is what makes the distinction possible, and it
 * also carries the statistics needed for ranking.
 *
 * Recognised [SourceConfig.params]:
 *  - `query` -- seed search terms, defaults to [DEFAULT_QUERY]
 *  - `regionCode` -- ISO 3166-1 alpha-2, optional
 */
class YouTubeShortsFeeler(
    private val http: Http,
    private val credentials: Credentials,
    private val searchBudget: SearchBudget = UnlimitedSearchBudget,
) : Feeler {

    override val type = SourceType.YOUTUBE_SHORTS

    override suspend fun fetch(config: SourceConfig, window: TimeWindow): FeelerResult {
        val key = credentials.youtubeApiKey()?.trim()
        if (key.isNullOrEmpty()) return FeelerResult.Unavailable("No YouTube API key set")

        if (!searchBudget.trySpend()) {
            return FeelerResult.Unavailable("Daily YouTube search quota reached")
        }

        val ids = try {
            searchIds(config, window, key)
        } catch (e: HttpFailure) {
            return FeelerResult.Unavailable("Network error: ${e.message}")
        } ?: return FeelerResult.Unavailable("YouTube search failed")

        if (ids.isEmpty()) return FeelerResult.Unavailable("No Shorts found in the last 24h")

        val details = try {
            details(ids, key)
        } catch (e: HttpFailure) {
            return FeelerResult.Unavailable("Network error: ${e.message}")
        } ?: return FeelerResult.Unavailable("YouTube video lookup failed")

        val posts = details.mapNotNull { it.toPost(config) }.filter { it.publishedAt in window }
        if (posts.isEmpty()) return FeelerResult.Unavailable("No results were actually Shorts")
        return FeelerResult.Success(posts)
    }

    private suspend fun searchIds(config: SourceConfig, window: TimeWindow, key: String): List<String>? {
        val query = config.params["query"]?.takeIf { it.isNotBlank() } ?: DEFAULT_QUERY
        val region = config.params["regionCode"]?.takeIf { it.isNotBlank() }

        val url = buildString {
            append("https://www.googleapis.com/youtube/v3/search")
            append("?part=snippet&type=video&videoDuration=short&order=viewCount")
            append("&maxResults=").append(SpotlightSpec.CANDIDATES_PER_SOURCE)
            append("&publishedAfter=").append(DateTimeFormatter.ISO_INSTANT.format(window.from))
            append("&q=").append(URLEncoder.encode(query, "UTF-8"))
            region?.let { append("&regionCode=").append(it) }
            append("&key=").append(key)
        }

        val response = http.get(url)
        if (!response.isSuccess) return null
        return json.decodeFromString<SearchResponse>(response.body).items.mapNotNull { it.id.videoId }
    }

    private suspend fun details(ids: List<String>, key: String): List<Video>? {
        val url = "https://www.googleapis.com/youtube/v3/videos" +
            "?part=contentDetails,statistics,snippet&id=${ids.joinToString(",")}&key=$key"

        val response = http.get(url)
        if (!response.isSuccess) return null
        return json.decodeFromString<VideoResponse>(response.body).items
    }

    private fun Video.toPost(config: SourceConfig): RawPost? {
        val length = runCatching { Duration.parse(contentDetails.duration) }.getOrNull() ?: return null
        // The actual Shorts ceiling. Without this, `videoDuration=short` leaks
        // ordinary videos of up to four minutes into a Shorts feed.
        if (length > MAX_SHORT_LENGTH) return null

        val published = runCatching { Instant.parse(snippet.publishedAt) }.getOrNull() ?: return null
        val views = statistics.viewCount?.toDoubleOrNull() ?: 0.0
        val likes = statistics.likeCount?.toDoubleOrNull() ?: 0.0

        return RawPost(
            sourceConfigId = config.id,
            externalId = id,
            title = snippet.title,
            permalink = "https://www.youtube.com/shorts/$id",
            publishedAt = published,
            // A like costs a deliberate tap where a view can be an autoplay, so
            // likes are weighted an order of magnitude higher.
            engagement = views + 10.0 * likes,
            thumbnailUrl = snippet.thumbnails?.best(),
            author = snippet.channelTitle,
        )
    }

    @Serializable private data class SearchResponse(val items: List<SearchItem> = emptyList())
    @Serializable private data class SearchItem(val id: SearchId)
    @Serializable private data class SearchId(val videoId: String? = null)

    @Serializable private data class VideoResponse(val items: List<Video> = emptyList())

    @Serializable
    private data class Video(
        val id: String,
        val snippet: Snippet,
        val contentDetails: ContentDetails,
        val statistics: Statistics = Statistics(),
    )

    @Serializable
    private data class Snippet(
        val title: String,
        val publishedAt: String,
        val channelTitle: String? = null,
        val thumbnails: Thumbnails? = null,
    )

    @Serializable
    private data class Thumbnails(
        val medium: Thumbnail? = null,
        val high: Thumbnail? = null,
        val default: Thumbnail? = null,
    ) {
        fun best(): String? = (high ?: medium ?: default)?.url
    }

    @Serializable private data class Thumbnail(val url: String)
    @Serializable private data class ContentDetails(val duration: String)

    @Serializable
    private data class Statistics(
        val viewCount: String? = null,
        val likeCount: String? = null,
    )

    companion object {
        /** Shorts have been capped at three minutes since October 2024. */
        val MAX_SHORT_LENGTH: Duration = Duration.ofSeconds(180)

        const val DEFAULT_QUERY = "#shorts funny"

        private val json = Json { ignoreUnknownKeys = true }
    }
}
