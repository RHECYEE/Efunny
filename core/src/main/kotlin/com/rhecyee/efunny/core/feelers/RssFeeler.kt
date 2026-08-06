package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.RawPost
import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import com.rhecyee.efunny.core.net.Http
import com.rhecyee.efunny.core.net.HttpFailure

/**
 * The generic configurable-website feeler: give it any RSS 2.0 or Atom URL and it
 * becomes a source. This is what makes "configurable websites like FML" a
 * settings row rather than a code change.
 *
 * Feeds carry no engagement data, so [RawPost.engagement] is left null and these
 * posts rank on recency alone. The UI labels them "Latest" rather than
 * "Trending", because claiming a trend signal the format cannot provide would be
 * a lie about the data.
 *
 * Recognised [SourceConfig.params]:
 *  - `url` (required) -- the feed
 *  - `text` -- `title` (default) or `description`; see [pickText]
 */
class RssFeeler(private val http: Http) : Feeler {

    override val type = SourceType.RSS

    override suspend fun fetch(config: SourceConfig, window: TimeWindow): FeelerResult {
        val url = config.params["url"]?.trim().orEmpty()
        if (url.isEmpty()) return FeelerResult.Unavailable("No feed URL configured")

        val response = try {
            http.get(url, mapOf("Accept" to ACCEPT))
        } catch (e: HttpFailure) {
            return FeelerResult.Unavailable("Network error: ${e.message}")
        }
        if (!response.isSuccess) return FeelerResult.Unavailable("Feed returned HTTP ${response.code}")

        val items = try {
            parse(response.body, config)
        } catch (e: Exception) {
            return FeelerResult.Unavailable("Could not parse feed: ${e.message}")
        }

        if (items.isEmpty()) return FeelerResult.Unavailable("Feed had no readable items")
        return FeelerResult.Success(items.filter { it.publishedAt in window })
    }

    internal fun parse(xml: String, config: SourceConfig): List<RawPost> =
        XmlFeed.entries(xml).mapNotNull { entry ->
            // A single item with a date this parser cannot read must not take the
            // whole feed down with it -- skip the item, keep the rest.
            val published = XmlFeed.parseDate(
                entry.text("pubDate", "published", "updated", "date", "dc:date"),
            ) ?: return@mapNotNull null

            val link = entry.link() ?: entry.text("guid") ?: return@mapNotNull null

            val title = pickText(
                title = entry.text("title").orEmpty(),
                description = entry.text("description", "summary", "content").orEmpty(),
                mode = config.params["text"] ?: "title",
            )
            if (title.isBlank()) return@mapNotNull null

            RawPost(
                sourceConfigId = config.id,
                externalId = entry.text("guid", "id") ?: link,
                title = title,
                permalink = link,
                publishedAt = published,
                engagement = null, // feeds carry no engagement signal
                author = entry.text("author", "dc:creator"),
            )
        }

    /**
     * Some feeds put the content in `<title>`; others use the title as a byline
     * and put the actual content in `<description>`. FML is the second kind, so
     * its seeded config sets `text=description`.
     *
     * This is a config switch rather than a guess on purpose. An earlier version
     * inferred it from title length, which the real FML feed promptly broke:
     * most of its titles are a bare "By Anonymous", but some read
     * "[spicy] | By Anonymous" or "By that's a low blow bro" -- long enough to
     * look like content while still being a byline. Nothing in the markup
     * separates the two cases, so the user's config decides and the parser does
     * as it is told.
     */
    private fun pickText(title: String, description: String, mode: String): String = when (mode) {
        "description" -> description.ifBlank { title }
        else -> title.ifBlank { description }
    }

    private companion object {
        const val ACCEPT =
            "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8"
    }
}
