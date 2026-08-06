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
import java.time.Clock
import java.time.Instant
import java.util.Base64

/**
 * Reddit humour subs, standing in for the Facebook groups that no longer have an
 * API.
 *
 * Auth uses the `installed_client` grant, which needs only a client ID and no
 * client secret -- the one OAuth flow that is genuinely safe to run from a
 * distributed APK. `/top?t=day` is a natural fit for the brief: Reddit does the
 * 24-hour trending window server-side, and returns the score and comment count
 * needed to rank within it.
 *
 * Recognised [SourceConfig.params]:
 *  - `subreddit` (required) -- without the `r/` prefix
 *  - `allowNsfw` -- `false` by default
 */
class RedditFeeler(
    private val http: Http,
    private val credentials: Credentials,
    private val clock: Clock = Clock.systemUTC(),
) : Feeler {

    override val type = SourceType.REDDIT

    private var cachedToken: String? = null
    private var tokenExpiresAt: Instant = Instant.EPOCH

    override suspend fun fetch(config: SourceConfig, window: TimeWindow): FeelerResult {
        val subreddit = config.params["subreddit"]?.trim()?.removePrefix("r/").orEmpty()
        if (subreddit.isEmpty()) return FeelerResult.Unavailable("No subreddit configured")

        val clientId = credentials.redditClientId()?.trim()
        if (clientId.isNullOrEmpty()) return FeelerResult.Unavailable("No Reddit client ID set")

        val token = try {
            token(clientId) ?: return FeelerResult.Unavailable("Reddit rejected the client ID")
        } catch (e: HttpFailure) {
            return FeelerResult.Unavailable("Network error: ${e.message}")
        }

        val url = "https://oauth.reddit.com/r/$subreddit/top" +
            "?t=day&limit=${SpotlightSpec.CANDIDATES_PER_SOURCE}&raw_json=1"

        val response = try {
            http.get(url, mapOf("Authorization" to "Bearer $token"))
        } catch (e: HttpFailure) {
            return FeelerResult.Unavailable("Network error: ${e.message}")
        }

        if (response.code == 429) return FeelerResult.Unavailable("Rate limited by Reddit")
        if (!response.isSuccess) return FeelerResult.Unavailable("Reddit returned HTTP ${response.code}")

        val allowNsfw = config.params["allowNsfw"].toBoolean()
        val posts = try {
            parse(response.body, config, allowNsfw)
        } catch (e: Exception) {
            return FeelerResult.Unavailable("Could not parse Reddit response: ${e.message}")
        }

        return FeelerResult.Success(posts.filter { it.publishedAt in window })
    }

    internal fun parse(body: String, config: SourceConfig, allowNsfw: Boolean): List<RawPost> =
        json.decodeFromString<Listing>(body).data.children
            .map { it.data }
            // Stickied posts are moderator announcements pinned to the top of
            // every sub. They are not trending, they are just permanently first.
            .filterNot { it.stickied }
            .filter { allowNsfw || !it.over18 }
            .map { child ->
                RawPost(
                    sourceConfigId = config.id,
                    externalId = child.id,
                    title = child.title,
                    permalink = "https://www.reddit.com${child.permalink}",
                    publishedAt = Instant.ofEpochSecond(child.createdUtc.toLong()),
                    // Comments weigh more than upvotes: an argument in the
                    // replies is a stronger signal that something landed than a
                    // passive scroll-by upvote.
                    engagement = child.ups + 2.0 * child.numComments,
                    thumbnailUrl = child.thumbnail?.takeIf { it.startsWith("http") },
                    author = child.author,
                )
            }

    private suspend fun token(clientId: String): String? {
        cachedToken?.let { if (clock.instant().isBefore(tokenExpiresAt)) return it }

        val basic = Base64.getEncoder().encodeToString("$clientId:".toByteArray())
        val response = http.postForm(
            url = "https://www.reddit.com/api/v1/access_token",
            form = mapOf(
                "grant_type" to "https://oauth.reddit.com/grants/installed_client",
                // Reddit's documented placeholder for clients that decline to
                // fingerprint the device.
                "device_id" to "DO_NOT_TRACK_THIS_DEVICE",
            ),
            headers = mapOf("Authorization" to "Basic $basic"),
        )
        if (!response.isSuccess) return null

        val token = json.decodeFromString<TokenResponse>(response.body)
        cachedToken = token.accessToken
        // Renew a minute early so a request cannot start on a token that expires
        // mid-flight.
        tokenExpiresAt = clock.instant().plusSeconds((token.expiresIn - 60).coerceAtLeast(0))
        return token.accessToken
    }

    @Serializable
    private data class TokenResponse(
        @SerialName("access_token") val accessToken: String,
        @SerialName("expires_in") val expiresIn: Long = 3600,
    )

    @Serializable
    private data class Listing(val data: ListingData)

    @Serializable
    private data class ListingData(val children: List<Child> = emptyList())

    @Serializable
    private data class Child(val data: Link)

    @Serializable
    private data class Link(
        val id: String,
        val title: String,
        val permalink: String,
        val ups: Int = 0,
        @SerialName("num_comments") val numComments: Int = 0,
        @SerialName("created_utc") val createdUtc: Double = 0.0,
        val thumbnail: String? = null,
        val author: String? = null,
        val stickied: Boolean = false,
        @SerialName("over_18") val over18: Boolean = false,
    )

    private companion object {
        val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    }
}
