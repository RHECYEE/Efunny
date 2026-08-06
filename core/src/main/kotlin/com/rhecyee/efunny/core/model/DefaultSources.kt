package com.rhecyee.efunny.core.model

/**
 * The seven slots EFunny ships with, one post from each per drop.
 *
 *     7 sources x 1 post per drop x 3 drops = 21 posts per day
 *
 * Four are live and three are dark. Enabling Instagram or TikTok later should
 * *replace* an RSS slot rather than add an eighth, so the arithmetic above
 * stays true.
 *
 * All of it is editable in the app -- these are just the rows a fresh install
 * starts with.
 */
object DefaultSources {

    val ALL: List<SourceConfig> = listOf(
        SourceConfig(
            id = 1,
            type = SourceType.YOUTUBE_SHORTS,
            displayName = "YouTube Shorts",
            params = mapOf("query" to "#shorts funny"),
            position = 0,
        ),
        SourceConfig(
            id = 2,
            type = SourceType.REDDIT,
            displayName = "r/funny",
            params = mapOf("subreddit" to "funny"),
            position = 1,
        ),
        SourceConfig(
            id = 3,
            type = SourceType.REDDIT,
            displayName = "r/memes",
            params = mapOf("subreddit" to "memes"),
            position = 2,
        ),
        SourceConfig(
            id = 4,
            type = SourceType.RSS,
            displayName = "FML",
            // FML's <title> is a byline ("By Anonymous"); the joke is in the
            // description, so this feed needs the text mode flipped.
            params = mapOf("url" to "https://www.fmylife.com/rss", "text" to "description"),
            position = 3,
        ),
        SourceConfig(
            id = 5,
            type = SourceType.RSS,
            displayName = "The Onion",
            params = mapOf("url" to "https://www.theonion.com/rss"),
            position = 4,
        ),
        SourceConfig(
            id = 6,
            type = SourceType.RSS,
            displayName = "McSweeney's",
            params = mapOf("url" to "https://www.mcsweeneys.net/rss"),
            position = 5,
        ),
        // The seventh slot is a live RSS source rather than one of the dark
        // platforms, so a fresh install can actually reach 7 posts a drop
        // before the user configures anything.
        SourceConfig(
            id = 7,
            type = SourceType.RSS,
            displayName = "Hard Drive",
            params = mapOf("url" to "https://hard-drive.net/feed/"),
            position = 6,
        ),

        // Registered, disabled, and documented. See ClosedPlatformFeelers.kt.
        SourceConfig(
            id = 8,
            type = SourceType.INSTAGRAM_REELS,
            displayName = "Instagram Reels",
            enabled = false,
            position = 7,
        ),
        SourceConfig(
            id = 9,
            type = SourceType.TIKTOK,
            displayName = "TikTok",
            enabled = false,
            position = 8,
        ),
        SourceConfig(
            id = 10,
            type = SourceType.FACEBOOK_GROUP,
            displayName = "Facebook humour groups",
            enabled = false,
            position = 9,
        ),
    )

    /** The rows a fresh install actually runs. */
    val ENABLED: List<SourceConfig> get() = ALL.filter { it.enabled }
}
