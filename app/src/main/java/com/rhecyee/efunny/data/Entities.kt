package com.rhecyee.efunny.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "source_config")
data class SourceConfigEntity(
    @PrimaryKey val id: Long,
    val type: String,
    val displayName: String,
    /** Type-specific settings as a JSON object; see [Converters]. */
    val params: Map<String, String>,
    val quotaPerDrop: Int,
    val enabled: Boolean,
    val position: Int,
    /** Last fetch outcome, shown as a health row on the Sources screen. */
    val lastResult: String? = null,
    val lastFetchedAt: Long? = null,
)

/**
 * A candidate that was actually published in a drop.
 *
 * The unique index on (sourceConfigId, externalId) is what makes re-running a
 * drop idempotent: a manual refresh re-inserts the same post rather than
 * duplicating it.
 */
@Entity(
    tableName = "post",
    indices = [
        Index(value = ["sourceConfigId", "externalId"], unique = true),
        Index(value = ["publishedAt"]),
    ],
)
data class PostEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sourceConfigId: Long,
    val externalId: String,
    val title: String,
    val permalink: String,
    val thumbnailUrl: String?,
    val author: String?,
    val publishedAt: Long,
    val engagement: Double?,
    val score: Double,
    val fetchedAt: Long,
)

/** One compiled drop. */
@Entity(
    tableName = "spotlight",
    indices = [Index(value = ["scheduledFor"], unique = true)],
)
data class SpotlightEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val slot: String,
    val scheduledFor: Long,
    val compiledAt: Long,
    /** Slots nobody could fill. Non-zero means every source was dry. */
    val shortfall: Int,
    /** Entries taken beyond quota to cover a source that fell short. */
    val backfilled: Int,
)

@Entity(
    tableName = "spotlight_entry",
    primaryKeys = ["spotlightId", "postId"],
    foreignKeys = [
        ForeignKey(
            entity = SpotlightEntity::class,
            parentColumns = ["id"],
            childColumns = ["spotlightId"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = PostEntity::class,
            parentColumns = ["id"],
            childColumns = ["postId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["postId"]), Index(value = ["spotlightId"])],
)
data class SpotlightEntryEntity(
    val spotlightId: Long,
    val postId: Long,
    val rank: Int,
)
