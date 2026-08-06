package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.RawPost
import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import com.rhecyee.efunny.core.net.Http
import com.rhecyee.efunny.core.net.HttpFailure
import com.rhecyee.efunny.core.spotlight.SpotlightSpec
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
 * Runs at one of two quality levels, and upgrades itself the moment a client ID
 * appears:
 *
 *  - **Keyless** (default). `/top/.rss?t=day` is public, needs no credentials at
 *    all, and still gets Reddit to do the 24-hour trending window server-side.
 *    What it does *not* carry is score or comment count, so these posts rank on
 *    recency like any other feed and are labelled "Latest".
 *  - **Authenticated**, once a client ID is set. The JSON API returns `ups` and
 *    `num_comments`, which is what genuine engagement ranking needs. Auth uses
 *    the `installed_client` grant -- no client secret, the one OAuth flow safe to
 *    run from a distributed APK.
 *
 * The keyless tier is why a fresh install has six working sources instead of
 * four, before the user has pasted anything.
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
        if (clientId.isNullOrEmpty()) return fetchKeyless(config, subreddit, window)

        return fetchAuthenticated(config, subreddit, clientId, window)
    }

    /**
     * The public feed. Ranks on recency because Reddit does not put scores in its
     * RSS -- worth knowing when comparing a keyless install against one with a
     * client ID.
     */
    private suspend fun fetchKeyless(
        config: SourceConfig,
        subreddit: String,
        window: TimeWindow,
    ): FeelerResult {
        val url = "https://www.reddit.com/r/$subreddit/top/.rss" +
            "?t=day&limit=${SpotlightSpec.CANDIDATES_PER_SOURCE}"

        val headers = mapOf("Accept" to "application/atom+xml, application/xml;q=0.9")

        // Measured against live Reddit: unauthenticated requests come back with
        // `x-ratelimit-remaining: 0.0` and a ~60s reset after a *single* call.
        // Since a drop fetches every source concurrently, two keyless subreddits
        // would otherwise guarantee a 429 on the second one. The mutex makes the
        // Reddit calls take turns, and the wait below respects the budget the
        // server actually advertises.
        //
        // This is affordable precisely because a drop is background work: a
        // minute of waiting inside a WorkManager job costs nothing, where the
        // same wait on a user-facing path would be unacceptable.
        return keylessGate.withLock {
            var response = try {
                http.get(url, headers)
            } catch (e: HttpFailure) {
                return@withLock FeelerResult.Unavailable("Network error: ${e.message}")
            }

            if (response.code == 429) {
                val wait = response.header("x-ratelimit-reset")?.toDoubleOrNull()?.toLong()
                    ?: response.header("retry-after")?.toLongOrNull()
                    ?: DEFAULT_RATE_LIMIT_WAIT_S
                delay(wait.coerceIn(1, MAX_RATE_LIMIT_WAIT_S) * 1_000L)

                response = try {
                    http.get(url, headers)
                } catch (e: HttpFailure) {
                    return@withLock FeelerResult.Unavailable("Network error: ${e.message}")
                }
            }

            when {
                response.code == 429 -> FeelerResult.Unavailable(
                    "Rate limited by Reddit - add a client ID in Sources to lift this",
                )
                // Reddit hard-blocks generic user agents. Worth naming, because
                // it looks nothing like a rate limit from the outside.
                response.code == 403 -> FeelerResult.Unavailable("Reddit rejected the request (403)")
                !response.isSuccess -> FeelerResult.Unavailable("Reddit returned HTTP ${response.code}")
                else -> parseKeyless(response.body, config, window)
            }
        }
    }

    private fun parseKeyless(body: String, config: SourceConfig, window: TimeWindow): FeelerResult {
        val posts = try {
            parseRss(body, config)
        } catch (e: Exception) {
            return FeelerResult.Unavailable("Could not parse Reddit feed: ${e.message}")
        }

        if (posts.isEmpty()) return FeelerResult.Unavailable("Reddit feed had no readable items")
        return FeelerResult.Success(posts.filter { it.publishedAt in window })
    }

    internal fun parseRss(xml: String, config: SourceConfig): List<RawPost> =
        XmlFeed.entries(xml).mapNotNull { entry ->
            val published = XmlFeed.parseDate(entry.text("published", "updated"))
                ?: return@mapNotNull null
            val link = entry.link() ?: return@mapNotNull null
            val title = entry.text("title")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null

            RawPost(
                sourceConfigId = config.id,
                // Reddit's Atom ids look like "t3_1vg19z7"; the bare id is what
                // the JSON API returns, so stripping it keeps dedup working
                // across an upgrade from keyless to authenticated.
                externalId = entry.text("id")?.removePrefix("t3_") ?: link,
                title = title,
                permalink = link,
                publishedAt = published,
                engagement = null, // RSS carries no score or comment count
                thumbnailUrl = entry.attr("media:thumbnail", "url"),
                author = entry.text("author")?.trim(),
            )
        }

    private suspend fun fetchAuthenticated(
        config: SourceConfig,
        subreddit: String,
        clientId: String,
        window: TimeWindow,
    ): FeelerResult {
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

        /** Serialises keyless calls so concurrent subreddits do not collide. */
        val keylessGate = Mutex()

        const val DEFAULT_RATE_LIMIT_WAIT_S = 60L
        const val MAX_RATE_LIMIT_WAIT_S = 70L
    }
}
