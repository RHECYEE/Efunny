package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow

/**
 * Platforms EFunny cannot legally read in v1.
 *
 * These are real registered feelers rather than deleted code, for three reasons:
 * the seven-slot shape stays intact, the reason each platform is dark is
 * recorded where the next developer will actually look for it, and enabling one
 * later means writing a fetch body instead of restructuring anything.
 *
 * Each returns [FeelerResult.Unavailable], which the compiler treats as an
 * ordinary shortfall and redistributes to a healthy source.
 */
sealed class ClosedPlatformFeeler(
    override val type: SourceType,
    private val reason: String,
) : Feeler {
    override suspend fun fetch(config: SourceConfig, window: TimeWindow): FeelerResult =
        FeelerResult.Unavailable(reason)
}

/**
 * Instagram is blocked by packaging, not policy: the Graph API's
 * `ig_hashtag_search` -> `top_media` route does return public Reels with
 * `like_count` and `comments_count`, capped at 30 unique hashtags per week.
 *
 * What it cannot do is run from a standalone APK. The flow needs a Meta app
 * secret, and a secret shipped inside a distributed binary is not a secret.
 * Enabling this means adding a token-broker service plus Meta App Review, which
 * was scoped out of v1 in favour of shipping without a backend.
 */
class InstagramReelsFeeler : ClosedPlatformFeeler(
    SourceType.INSTAGRAM_REELS,
    "Needs a server: the Meta app secret cannot ship inside an APK",
)

/**
 * TikTok has no legal trending endpoint for this use case. The Research API is
 * restricted to accredited academic and non-profit institutions and explicitly
 * excludes commercial, agency and independent developers; the Display API only
 * returns the authenticated user's own videos, never a trending feed.
 *
 * Scraping is not a fallback here -- it breaks TikTok's terms, breaks constantly
 * in practice, and risks the account and IP doing it.
 */
class TikTokFeeler : ClosedPlatformFeeler(
    SourceType.TIKTOK,
    "No public API: TikTok Research API is academic-only, Display API is self-only",
)

/**
 * Facebook groups have no API at all any more. The Groups API was deprecated
 * with Graph v19 in January 2024 and removed from *every* API version on
 * 22 April 2024, taking `groups_access_member_info` and `publish_to_groups` with
 * it. No permission, review or partnership restores third-party read access to
 * an ordinary group feed.
 *
 * Reddit humour subs fill this slot instead.
 */
class FacebookGroupsFeeler : ClosedPlatformFeeler(
    SourceType.FACEBOOK_GROUP,
    "Groups API was removed from all Graph API versions on 22 Apr 2024",
)
