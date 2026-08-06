package com.rhecyee.efunny.core

import com.rhecyee.efunny.core.model.RawPost
import java.time.Instant

/**
 * Builds candidate posts for tests.
 *
 * Titles are composed from four rotating word lists rather than a counter,
 * because near-identical titles are exactly what [com.rhecyee.efunny.core.spotlight.Deduper]
 * is built to collapse. An earlier version of these fixtures used
 * "Source 1 candidate number 2", which shares eight of nine tokens with
 * "Source 1 candidate number 1" -- comfortably over the 0.8 similarity
 * threshold, so the deduper correctly ate the entire pool and several tests
 * failed for reasons that had nothing to do with what they were testing.
 *
 * Any two titles produced here share at most two tokens (Jaccard ~0.33).
 */
object TestPosts {

    private val SUBJECTS = listOf(
        "cat", "dog", "landlord", "barista", "neighbour", "dentist", "pigeon",
        "toddler", "plumber", "robot",
    )
    private val OCCASIONS = listOf(
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
        "sunday", "holiday", "weekend", "solstice",
    )
    private val VERBS = listOf(
        "devoured", "shredded", "reprogrammed", "auctioned", "laminated",
        "serenaded", "photocopied", "juggled", "varnished", "hypnotised",
    )
    private val OBJECTS = listOf(
        "sofa", "curtains", "lawnmower", "doorbell", "toaster", "bicycle",
        "houseplant", "mailbox", "piano", "umbrella",
    )

    /** Distinct in both dimensions: the source varies subject and occasion, the index varies verb and object. */
    fun title(sourceId: Long, index: Int): String {
        val s = SUBJECTS[((sourceId - 1).mod(SUBJECTS.size.toLong())).toInt()]
        val o = OCCASIONS[((sourceId - 1).mod(OCCASIONS.size.toLong())).toInt()]
        val v = VERBS[(index - 1).mod(VERBS.size)]
        val obj = OBJECTS[(index - 1).mod(OBJECTS.size)]
        return "My $s $v the $obj on a $o"
    }

    fun post(
        sourceId: Long,
        index: Int,
        now: Instant,
        ageHours: Long = index.toLong(),
        engagement: Double? = (10_000 - index * 100).toDouble(),
    ) = RawPost(
        sourceConfigId = sourceId,
        externalId = "s$sourceId-p$index",
        title = title(sourceId, index),
        permalink = "https://example.com/s$sourceId/p$index",
        publishedAt = now.minusSeconds(ageHours * 3600),
        engagement = engagement,
    )

    fun pool(sourceId: Long, count: Int, now: Instant): List<RawPost> =
        (1..count).map { post(sourceId, it, now) }
}
