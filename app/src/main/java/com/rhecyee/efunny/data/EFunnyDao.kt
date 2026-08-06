package com.rhecyee.efunny.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

/** A post as it appears in a drop, joined with the rank it was given. */
data class SpotlightPost(
    val id: Long,
    val sourceConfigId: Long,
    val externalId: String,
    val title: String,
    val permalink: String,
    val thumbnailUrl: String?,
    val author: String?,
    val publishedAt: Long,
    val engagement: Double?,
    val score: Double,
    val rank: Int,
    val sourceName: String,
    val sourceType: String,
)

@Dao
interface EFunnyDao {

    // ---- sources ----

    @Query("SELECT * FROM source_config ORDER BY position")
    fun observeSources(): Flow<List<SourceConfigEntity>>

    @Query("SELECT * FROM source_config ORDER BY position")
    suspend fun sources(): List<SourceConfigEntity>

    @Query("SELECT COUNT(*) FROM source_config")
    suspend fun sourceCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSources(sources: List<SourceConfigEntity>)

    @Update
    suspend fun updateSource(source: SourceConfigEntity)

    @Query("DELETE FROM source_config WHERE id = :id")
    suspend fun deleteSource(id: Long)

    @Query("SELECT COALESCE(MAX(id), 0) FROM source_config")
    suspend fun maxSourceId(): Long

    @Query("UPDATE source_config SET lastResult = :result, lastFetchedAt = :at WHERE id = :id")
    suspend fun recordFetch(id: Long, result: String, at: Long)

    // ---- posts ----

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertPost(post: PostEntity): Long

    @Query("SELECT id FROM post WHERE sourceConfigId = :sourceId AND externalId = :externalId LIMIT 1")
    suspend fun findPostId(sourceId: Long, externalId: String): Long?

    // ---- spotlights ----

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertSpotlight(spotlight: SpotlightEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEntries(entries: List<SpotlightEntryEntity>)

    @Query("SELECT * FROM spotlight WHERE scheduledFor = :scheduledFor LIMIT 1")
    suspend fun spotlightAt(scheduledFor: Long): SpotlightEntity?

    @Query("SELECT * FROM spotlight ORDER BY scheduledFor DESC LIMIT 1")
    fun observeLatestSpotlight(): Flow<SpotlightEntity?>

    @Query("SELECT * FROM spotlight ORDER BY scheduledFor DESC LIMIT :limit")
    fun observeRecentSpotlights(limit: Int): Flow<List<SpotlightEntity>>

    @Query(
        """
        SELECT p.id, p.sourceConfigId, p.externalId, p.title, p.permalink, p.thumbnailUrl,
               p.author, p.publishedAt, p.engagement, p.score, e.rank,
               s.displayName AS sourceName, s.type AS sourceType
        FROM spotlight_entry e
        JOIN post p ON p.id = e.postId
        LEFT JOIN source_config s ON s.id = p.sourceConfigId
        WHERE e.spotlightId = :spotlightId
        ORDER BY e.rank
        """,
    )
    fun observeEntries(spotlightId: Long): Flow<List<SpotlightPost>>

    /**
     * Fingerprint material for cross-drop dedup: everything published in the
     * last few drops, which is what stops the evening set rerunning the
     * afternoon's.
     */
    @Query(
        """
        SELECT p.* FROM post p
        JOIN spotlight_entry e ON e.postId = p.id
        WHERE e.spotlightId IN (SELECT id FROM spotlight ORDER BY scheduledFor DESC LIMIT :drops)
        """,
    )
    suspend fun postsFromRecentDrops(drops: Int): List<PostEntity>

    // ---- retention ----

    @Query("DELETE FROM spotlight WHERE compiledAt < :before")
    suspend fun pruneSpotlights(before: Long)

    /**
     * Candidates are fetched far more generously than they are published, so
     * orphans -- posts never picked for any drop -- are the bulk of the table.
     */
    @Query("DELETE FROM post WHERE fetchedAt < :before AND id NOT IN (SELECT postId FROM spotlight_entry)")
    suspend fun pruneOrphanPosts(before: Long)

    @Transaction
    suspend fun prune(before: Long) {
        pruneSpotlights(before)
        pruneOrphanPosts(before)
    }
}
