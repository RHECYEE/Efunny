package com.rhecyee.efunny.data

import com.rhecyee.efunny.core.feelers.FeelerResult
import com.rhecyee.efunny.core.model.RawPost
import com.rhecyee.efunny.core.schedule.DropSlot
import com.rhecyee.efunny.core.spotlight.CompiledDrop
import com.rhecyee.efunny.core.spotlight.Deduper
import com.rhecyee.efunny.core.spotlight.PostFingerprint
import com.rhecyee.efunny.core.spotlight.SpotlightService
import com.rhecyee.efunny.core.spotlight.SpotlightSpec
import kotlinx.coroutines.flow.Flow
import java.time.Clock
import java.time.Duration
import java.time.Instant

/**
 * Bridges the pure compilation pipeline in `:core` to Room.
 *
 * Persisting each drop is what lets the app open instantly and read offline, lets
 * the user browse the day's three sets, and -- the load-bearing one -- gives
 * cross-drop dedup something to check against.
 */
class SpotlightRepository(
    private val dao: EFunnyDao,
    private val service: SpotlightService,
    private val deduper: Deduper,
    private val clock: Clock,
) {

    /** Seeds the seven default rows on first launch, and never again. */
    suspend fun ensureSeeded() {
        if (dao.sourceCount() == 0) dao.upsertSources(defaultSourceEntities())
    }

    fun observeSources(): Flow<List<SourceConfigEntity>> = dao.observeSources()

    fun observeLatestSpotlight(): Flow<SpotlightEntity?> = dao.observeLatestSpotlight()

    fun observeRecentSpotlights(limit: Int = 12): Flow<List<SpotlightEntity>> =
        dao.observeRecentSpotlights(limit)

    fun observeEntries(spotlightId: Long): Flow<List<SpotlightPost>> = dao.observeEntries(spotlightId)

    /**
     * Runs one drop and stores it.
     *
     * [scheduledFor] is the slot's wall-clock instant rather than "now", so a
     * worker that fires a few minutes late still writes to the 15:00 drop
     * instead of creating a fourth one.
     */
    suspend fun runDrop(slot: DropSlot, scheduledFor: Instant): CompiledDrop {
        ensureSeeded()

        val configs = dao.sources().map { it.toCore() }
        val previouslyShown = recentFingerprints()

        val drop = service.runDrop(configs, previouslyShown)

        persist(slot, scheduledFor, drop)
        recordSourceHealth(drop)
        prune()
        return drop
    }

    /** Everything published in the last few drops, for cross-drop dedup. */
    private suspend fun recentFingerprints(): List<PostFingerprint> =
        dao.postsFromRecentDrops(SpotlightSpec.DEDUP_AGAINST_PREVIOUS_DROPS).map { entity ->
            PostFingerprint(
                externalId = entity.externalId,
                permalink = entity.permalink.trim().lowercase(),
                tokens = deduper.fingerprint(
                    RawPost(
                        sourceConfigId = entity.sourceConfigId,
                        externalId = entity.externalId,
                        title = entity.title,
                        permalink = entity.permalink,
                        publishedAt = Instant.ofEpochMilli(entity.publishedAt),
                    ),
                ).tokens,
            )
        }

    private suspend fun persist(slot: DropSlot, scheduledFor: Instant, drop: CompiledDrop) {
        val now = clock.instant().toEpochMilli()

        val spotlightId = dao.insertSpotlight(
            SpotlightEntity(
                // Re-running the same slot replaces it rather than stacking a
                // duplicate, which is what makes manual refresh safe.
                id = dao.spotlightAt(scheduledFor.toEpochMilli())?.id ?: 0,
                slot = slot.name,
                scheduledFor = scheduledFor.toEpochMilli(),
                compiledAt = now,
                shortfall = drop.shortfall,
                backfilled = drop.backfilled,
            ),
        )

        val entries = drop.entries.mapIndexed { index, scored ->
            val post = scored.post
            val existingId = dao.findPostId(post.sourceConfigId, post.externalId)
            val postId = dao.insertPost(
                PostEntity(
                    id = existingId ?: 0,
                    sourceConfigId = post.sourceConfigId,
                    externalId = post.externalId,
                    title = post.title,
                    permalink = post.permalink,
                    thumbnailUrl = post.thumbnailUrl,
                    author = post.author,
                    publishedAt = post.publishedAt.toEpochMilli(),
                    engagement = post.engagement,
                    score = scored.score,
                    fetchedAt = now,
                ),
            )
            SpotlightEntryEntity(spotlightId = spotlightId, postId = postId, rank = index)
        }

        dao.insertEntries(entries)
    }

    private suspend fun recordSourceHealth(drop: CompiledDrop) {
        val now = clock.instant().toEpochMilli()
        val contributed = drop.entries.groupingBy { it.post.sourceConfigId }.eachCount()

        dao.sources().forEach { source ->
            val reason = drop.unavailable[source.displayName]
            val result = when {
                !source.enabled -> "Disabled"
                reason != null -> reason
                else -> "OK - ${contributed[source.id] ?: 0} in this drop"
            }
            dao.recordFetch(source.id, result, now)
        }
    }

    /** At 21 posts a day the published set is tiny; the unused candidate pool is not. */
    private suspend fun prune() {
        dao.prune(clock.instant().minus(Duration.ofDays(RETENTION_DAYS)).toEpochMilli())
    }

    private companion object {
        const val RETENTION_DAYS = 30L
    }
}

/** Convenience for the Sources screen's health row. */
fun FeelerResult.describe(): String = when (this) {
    is FeelerResult.Success -> "OK - ${posts.size} candidates"
    is FeelerResult.Unavailable -> reason
}
